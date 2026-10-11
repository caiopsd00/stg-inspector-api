import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

// Deliberately limited to the local BR LIFT Compose database, never DATABASE_URL.
const root = path.resolve(
  process.env.BRLIFT_PROJECT_DIR ||
    fileURLToPath(new URL("..", import.meta.url)),
);
const database = process.argv[2];
if (
  !["brlift", "brlift_test"].includes(database) ||
  process.argv[3] !== "--confirm-delete"
)
  throw Error(
    "Uso: node scripts/reset-local-db.mjs brlift|brlift_test --confirm-delete. APAGA o banco escolhido após backup.",
  );
if (
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
    .name !== "brlift-api"
)
  throw Error("Projeto não é BR LIFT.");
const args = [
  "compose",
  "--project-directory",
  root,
  "-f",
  path.join(root, "docker-compose.yml"),
];
const run = (tail) =>
  execFileSync("docker", [...args, ...tail], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const config = JSON.parse(run(["config", "--format", "json"]));
if (
  config.name !== "brlift" ||
  config.services.postgres.environment.POSTGRES_DB !== "brlift" ||
  !config.services.postgres.ports.some(
    (p) => Number(p.published) === 5440 && p.host_ip === "127.0.0.1",
  )
)
  throw Error("Reset permitido somente no Compose local BR LIFT, porta 5440.");
const running = run(["ps", "--status", "running", "--services"])
  .trim()
  .split("\n");
if (database === "brlift" && running.includes("api"))
  throw Error("Pare apenas a API: docker compose stop api. Depois repita.");
const backup = path.join(
  root,
  "..",
  ".brlift-backups",
  "relational-" +
    new Date().toISOString().replaceAll(":", "-") +
    "-" +
    database,
);
await fs.mkdir(backup, { recursive: true, mode: 0o700 });
const dump = path.join(backup, database + ".dump");
const child = spawn(
  "docker",
  [
    ...args,
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "brlift",
    "-Fc",
    database,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (v) => (stderr += v));
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) =>
    code === 0 ? resolve() : reject(Error("pg_dump falhou: " + stderr)),
  );
});
await Promise.all([
  pipeline(child.stdout, createWriteStream(dump, { flags: "wx", mode: 0o600 })),
  exited,
]);
if ((await fs.stat(dump)).size < 100)
  throw Error("Backup vazio; banco preservado.");
// Verify the archive can be read by the same PostgreSQL toolchain.
execFileSync(
  "docker",
  [...args, "exec", "-T", "postgres", "pg_restore", "--list"],
  { input: await fs.readFile(dump), stdio: ["pipe", "ignore", "pipe"] },
);
if (database === "brlift") {
  try {
    await fs.cp(
      path.join(root, "storage"),
      path.join(backup, "local-storage"),
      { recursive: true },
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const apiId = run(["ps", "-aq", "api"]).trim();
  if (apiId)
    execFileSync(
      "docker",
      ["cp", apiId + ":/app/storage", path.join(backup, "container-storage")],
      { stdio: "pipe" },
    );
}
run([
  "exec",
  "-T",
  "postgres",
  "psql",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "brlift",
  "-d",
  "postgres",
  "-c",
  'DROP DATABASE "' + database + '" WITH (FORCE)',
]);
run([
  "exec",
  "-T",
  "postgres",
  "createdb",
  "-U",
  "brlift",
  "-O",
  "brlift",
  database,
]);
console.log(
  "Banco local recriado vazio: " +
    database +
    "\nBackup verificado: " +
    backup +
    "\nPróximo passo: npm run db:migrate; depois npm run create:admin.",
);
