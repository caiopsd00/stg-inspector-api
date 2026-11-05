// Creates and removes its OWN Compose project. Never uses the production .env.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = "brlift-smoke-" + crypto.randomUUID().slice(0, 8);
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "brlift-production-smoke-"),
);
const envFile = path.join(directory, ".env.smoke");
const override = path.join(directory, "compose.smoke.yml");
const password = crypto.randomBytes(24).toString("hex");
const env = {
  ...process.env,
  DOMAIN: "smoke.invalid",
  POSTGRES_PASSWORD: crypto.randomBytes(24).toString("hex"),
  STORAGE_WRITE_BACKEND: "local",
  STORAGE_READ_BACKENDS: "local",
  GCS_BUCKET: "",
};
await fs.writeFile(envFile, "", { mode: 0o600 });
await fs.writeFile(
  override,
  'services:\n  api:\n    ports: ["127.0.0.1::3333"]\n',
);

function compose(...args) {
  return execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      envFile,
      "-f",
      path.join(root, "compose.production.yml"),
      "-f",
      override,
      ...args,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 600000,
      ...(args[0] === "build"
        ? { stdio: ["ignore", "inherit", "inherit"] }
        : {}),
    },
  );
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
let base;
async function waitForHealth() {
  const [port] = compose("port", "api", "3333").trim().split("\n");
  base = "http://" + port;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(base + "/health", {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return response.json();
    } catch {
      /* Wait for the isolated API to finish restarting. */
    }
    await pause();
  }
  throw Error("API temporária não ficou pronta.");
}
let token = "";
let databaseId = "";
async function request(
  url,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(base + "/api" + url, {
    method,
    signal: AbortSignal.timeout(150000),
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "X-BRLIFT-Contract": "4",
      "X-BRLIFT-Database": databaseId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isPdf = response.headers
    .get("content-type")
    ?.includes("application/pdf");
  const result = isPdf
    ? Buffer.from(await response.arrayBuffer())
    : await response.json();
  assert.ok(
    response.ok,
    `${method} ${url}: ${response.status} ${JSON.stringify(result)}`,
  );
  return result;
}

try {
  compose("config", "--quiet");
  console.log("Construindo a imagem da API para o ensaio isolado...");
  compose("build", "api");
  compose("up", "-d", "--wait", "api");
  const health = await waitForHealth();
  databaseId = health.databaseId;
  assert.equal(health.contractVersion, 4);
  const container = compose("ps", "-q", "api").trim();
  const [configuration] = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
  );
  assert.equal(configuration.HostConfig.Memory, 1536 * 1024 * 1024);
  assert.equal(configuration.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(configuration.HostConfig.Init, true);
  assert.equal(configuration.HostConfig.LogConfig.Type, "local");
  assert.ok(configuration.Config.Env.includes("STORAGE_WRITE_BACKEND=local"));

  const bootstrap = `
    import {createUserAndTechnician} from './dist/server/users.js';
    import {newReport} from './dist/contracts/domain.js';
    import {createTemplateSections} from './dist/contracts/inspection-template.js';
    import {pool} from './dist/server/db.js';
    try {
      const account = await createUserAndTechnician({name:'Smoke', email:'smoke@example.test', cpf:'12345678901', password:${JSON.stringify(password)}, role:'admin'});
      console.log(JSON.stringify({technicianId:account.technician.id, report:newReport(), sections:createTemplateSections()}));
    } finally { await pool.end(); }
  `;
  const fixtures = JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--project-name",
        project,
        "--env-file",
        envFile,
        "-f",
        path.join(root, "compose.production.yml"),
        "-f",
        override,
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
      ],
      { cwd: root, env, input: bootstrap, encoding: "utf8" },
    ),
  );
  ({ token } = await request("/auth/login", {
    email: "smoke@example.test",
    password,
  }));

  const clientId = crypto.randomUUID();
  const equipmentId = crypto.randomUUID();
  await request(
    `/catalog/clients/${clientId}`,
    { name: "Cliente smoke", identifier: "12345678000195", baseVersion: 0 },
    "PUT",
  );
  const equipment = {
    type: "Guindaste",
    brand: "Marca smoke",
    model: "Modelo smoke",
    serial: "SMOKE-1",
  };
  await request(
    `/catalog/equipment/${equipmentId}`,
    { name: "Equipamento smoke", clientId, data: equipment, baseVersion: 0 },
    "PUT",
  );

  const photo = await sharp({
    create: { width: 240, height: 160, channels: 3, background: "#e0f12d" },
  })
    .jpeg()
    .toBuffer();
  const { media } = await request("/media", {
    name: "smoke.jpg",
    dataUrl: "data:image/jpeg;base64," + photo.toString("base64"),
  });
  const unauthorized = await fetch(base + media.uri);
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const readMedia = async () => {
    const response = await fetch(base + media.uri, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/jpeg/);
    return Buffer.from(await response.arrayBuffer());
  };
  const savedBytes = await readMedia();
  const now = new Date().toISOString();
  const common = {
    clientId,
    technicianId: fixtures.technicianId,
    equipmentId,
    date: now.slice(0, 10),
    status: "finalized",
    baseVersion: 0,
  };
  const reportId = crypto.randomUUID();
  await request(
    `/reports/${reportId}`,
    {
      ...common,
      number: "SMOKE-AT",
      mutationId: crypto.randomUUID(),
      payload: {
        ...fixtures.report,
        type: "interno",
        equipment,
        concluded: "Sim",
        released: "Sim",
        photosSent: "Sim",
        technicianSignature: media,
        clientSignature: media,
        reasons: [
          {
            id: "reason",
            description: "Smoke",
            pending: "",
            services: [
              {
                id: "service",
                description: "Validação local",
                notes: "",
                photos: [media],
              },
            ],
          },
        ],
      },
    },
    "PUT",
  );
  for (const section of fixtures.sections)
    for (const item of section.items) item.situation = "A";
  const inspectionId = crypto.randomUUID();
  await request(
    `/inspections/${inspectionId}`,
    {
      ...common,
      number: "SMOKE-IN",
      mutationId: crypto.randomUUID(),
      payload: {
        id: inspectionId,
        name: "Smoke local",
        createdAt: now,
        updatedAt: now,
        documentFields: {
          "000": "SMOKE-IN",
          "001": "Guindaste",
          "002": equipment.model,
          "003": equipment.serial,
          "007": "0",
          "010": now.slice(0, 10),
          "011": "Aprovada",
        },
        sections: fixtures.sections,
        documentImages: { "013": [media] },
        technicianSignature: media,
        clientSignature: media,
      },
    },
    "PUT",
  );
  for (const [kind, id] of [
    ["reports", reportId],
    ["inspections", inspectionId],
  ]) {
    const pdf = await request(`/${kind}/${id}/document/pdf`);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    console.log(
      `${kind}: finalização e PDF com foto local OK (${pdf.length} bytes).`,
    );
  }

  compose("up", "-d", "--wait", "--force-recreate", "api", "postgres");
  assert.equal((await waitForHealth()).databaseId, databaseId);
  assert.deepEqual(await readMedia(), savedBytes);
  assert.equal(
    (await request(`/reports/${reportId}`)).item.status,
    "finalized",
  );
  assert.equal(
    (await request(`/inspections/${inspectionId}`)).item.status,
    "finalized",
  );
  console.log(
    "Volumes preservaram banco, sessão e mídia após recriar os containers.",
  );
  const apiBeforeRestart = compose("ps", "-q", "api").trim();
  compose("restart", "postgres");
  await waitForHealth();
  assert.equal(compose("ps", "-q", "api").trim(), apiBeforeRestart);
  assert.equal(
    (await request(`/reports/${reportId}`)).item.status,
    "finalized",
  );
  console.log("API recuperou as conexões após reiniciar apenas o PostgreSQL.");
  console.log(
    compose(
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      "console.log('Node heap:',Math.round(require('v8').getHeapStatistics().heap_size_limit/1024/1024),'MiB')",
    ).trim(),
  );
  console.log(
    "Smoke de produção local concluído com limite de 1 vCPU e 1536 MiB na API.",
  );
} catch (error) {
  try {
    console.error(compose("logs", "--tail=60", "api", "postgres"));
  } catch {
    /* Original error below. */
  }
  throw error;
} finally {
  try {
    compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
