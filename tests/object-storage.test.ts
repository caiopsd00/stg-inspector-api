import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import type { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import JSZip from "jszip";

import {
  newDay,
  newReport,
  type Entry,
  type Report,
} from "../contracts/domain.js";
import { createReportPdf } from "../server/report-pdf.js";
import { documentForRecord } from "../server/documents.js";
import { parseStorageConfig } from "../server/object-storage/config.js";
import { GoogleCloudStorage } from "../server/object-storage/gcs.js";
import {
  RoutedStorage,
  getObjectStorage,
  mediaStorageKey,
} from "../server/object-storage/index.js";
import { LocalStorage } from "../server/object-storage/local.js";
import { migrateFile } from "../server/object-storage/migrate.js";
import {
  StorageConflictError,
  StorageNotFoundError,
} from "../server/object-storage/types.js";

function fakeCloud() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  let readError: Error | undefined;
  const client = {
    bucket: () => ({
      async getMetadata() {
        return [
          {
            iamConfiguration: {
              publicAccessPrevention: "enforced",
              uniformBucketLevelAccess: { enabled: true },
            },
          },
        ];
      },
      file: (key: string) => ({
        async save(
          bytes: Buffer,
          options: { preconditionOpts: { ifGenerationMatch: number } },
        ) {
          assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
          if (objects.has(key))
            throw Object.assign(Error("exists"), { code: 412 });
          objects.set(key, Buffer.from(bytes));
        },
        async download() {
          reads.push(key);
          if (readError) throw readError;
          const bytes = objects.get(key);
          if (!bytes) throw Object.assign(Error("missing"), { code: 404 });
          return [bytes];
        },
        async exists() {
          return [objects.has(key)];
        },
        async delete() {
          objects.delete(key);
        },
      }),
    }),
  } as unknown as Storage;
  return {
    storage: new GoogleCloudStorage("private-test-bucket", client),
    objects,
    reads,
    failReads(error?: Error) {
      readError = error;
    },
  };
}

const timestamp = "2026-10-11T00:00:00.000Z";

test("volume local é verificado sem deixar arquivos de teste e sem sobrescrever mídia", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-local-ready-"));
  try {
    const storage = new LocalStorage(dir);
    await storage.assertReady();
    assert.deepEqual(await fs.readdir(path.join(dir, "media")), []);
    await storage.save("media/permanent", Buffer.from("original"));
    const writes = await Promise.allSettled([
      storage.save("media/permanent", Buffer.from("replacement")),
      storage.save("media/new", Buffer.from("complete image")),
    ]);
    assert.equal(writes[0].status, "rejected");
    assert.equal(writes[1].status, "fulfilled");
    assert.equal(
      (await storage.read("media/permanent")).toString(),
      "original",
    );
    assert.deepEqual((await fs.readdir(path.join(dir, "media"))).sort(), [
      "new",
      "permanent",
    ]);
    const stat = await fs.stat(path.join(dir, "media", "new"));
    assert.equal(stat.mode & 0o777, 0o600);
    const concurrent = await Promise.allSettled([
      storage.save("media/race", Buffer.alloc(1024, 1)),
      storage.save("media/race", Buffer.alloc(1024, 2)),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const winner = await storage.read("media/race");
    assert.ok(
      winner.equals(Buffer.alloc(1024, 1)) ||
        winner.equals(Buffer.alloc(1024, 2)),
    );
    assert.ok(
      !(await fs.readdir(path.join(dir, "media"))).some((name) =>
        name.startsWith(".upload-"),
      ),
    );
    const invalidRoot = path.join(dir, "not-a-directory");
    await fs.writeFile(invalidRoot, "file");
    await assert.rejects(new LocalStorage(invalidRoot).assertReady());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function reportEntry(id: string): Entry {
  const payload = newReport();
  payload.reasons = [
    {
      id: "reason",
      description: "Vistoria",
      pending: "",
      services: [
        {
          id: "service",
          description: "Foto",
          notes: "",
          photos: [{ id, uri: `/api/media/${id}`, name: "foto.jpg" }],
        },
      ],
    },
  ];
  return {
    id: "test",
    kind: "reports",
    number: "123",
    clientId: null,
    technicianId: null,
    equipmentId: null,
    date: "2026-10-11",
    status: "draft",
    payload,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function inspectionEntry(id: string): Entry {
  return {
    id: "inspection-test",
    kind: "inspections",
    number: "456",
    clientId: null,
    technicianId: null,
    equipmentId: null,
    date: "2026-10-11",
    status: "draft",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    payload: {
      id: "inspection-test",
      name: "Inspeção",
      createdAt: timestamp,
      updatedAt: timestamp,
      documentFields: {},
      sections: [],
      documentImages: {
        "013": [
          {
            id,
            uri: `/api/media/${id}`,
            name: "foto.jpg",
            createdAt: timestamp,
          },
        ],
      },
    },
  };
}

test("configuração rejeita modos inválidos e exige bucket no GCS", () => {
  assert.deepEqual(parseStorageConfig({}).reads, ["local"]);
  assert.deepEqual(
    parseStorageConfig({
      STORAGE_WRITE_BACKEND: "gcs",
      STORAGE_READ_BACKENDS: "gcs,local",
      GCS_BUCKET: "private-test-bucket",
    }).reads,
    ["gcs", "local"],
  );
  assert.throws(
    () =>
      parseStorageConfig({
        STORAGE_WRITE_BACKEND: "gcs",
        STORAGE_READ_BACKENDS: "gcs",
      }),
    /GCS_BUCKET/,
  );
  assert.throws(
    () =>
      parseStorageConfig({
        STORAGE_WRITE_BACKEND: "local",
        STORAGE_READ_BACKENDS: "gcs,local",
      }),
    /inválidos/,
  );
  assert.throws(
    () => parseStorageConfig({ STORAGE_READ_BACKENDS: "local,gcs" }),
    /inválidos/,
  );
  assert.throws(
    () => parseStorageConfig({ STORAGE_WRITE_BACKEND: "" }),
    /inválidos/,
  );
});

test("GCS rejeita bucket sem proteção contra acesso público", async () => {
  const client = {
    bucket: () => ({
      getMetadata: async () => [
        { iamConfiguration: { publicAccessPrevention: "inherited" } },
      ],
    }),
  } as unknown as Storage;
  await assert.rejects(
    new GoogleCloudStorage("private-test-bucket", client).assertPrivateBucket(),
    /Public Access Prevention/,
  );
});

test("instalação somente local salva, lê e exclui sem GCS", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-local-storage-"));
  const before = {
    dir: process.env.STORAGE_DIR,
    write: process.env.STORAGE_WRITE_BACKEND,
    reads: process.env.STORAGE_READ_BACKENDS,
    bucket: process.env.GCS_BUCKET,
  };
  try {
    process.env.STORAGE_DIR = dir;
    process.env.STORAGE_WRITE_BACKEND = "local";
    process.env.STORAGE_READ_BACKENDS = "local";
    delete process.env.GCS_BUCKET;
    const storage = getObjectStorage();
    await storage.save("media/test", Buffer.from("local"));
    assert.equal((await storage.read("media/test")).toString(), "local");
    assert.equal(await storage.exists("media/test"), true);
    await assert.rejects(
      storage.save("media/test", Buffer.from("again")),
      StorageConflictError,
    );
    await assert.rejects(
      storage.read("../escape"),
      /Chave de armazenamento inválida/,
    );
    await storage.delete("media/test");
    assert.equal(await storage.exists("media/test"), false);
  } finally {
    if (before.dir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = before.dir;
    if (before.write === undefined) delete process.env.STORAGE_WRITE_BACKEND;
    else process.env.STORAGE_WRITE_BACKEND = before.write;
    if (before.reads === undefined) delete process.env.STORAGE_READ_BACKENDS;
    else process.env.STORAGE_READ_BACKENDS = before.reads;
    if (before.bucket === undefined) delete process.env.GCS_BUCKET;
    else process.env.GCS_BUCKET = before.bucket;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GCS escreve sem sobrescrever e fallback só ocorre para arquivo ausente", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-fallback-"));
  try {
    const local = new LocalStorage(dir);
    const cloud = fakeCloud();
    const routed = new RoutedStorage(cloud.storage, [cloud.storage, local]);
    const photoId = randomUUID();
    const photoKey = mediaStorageKey(photoId);
    const photo = await sharp({
      create: { width: 160, height: 120, channels: 3, background: "#f6d252" },
    })
      .jpeg()
      .toBuffer();
    await local.save(photoKey, photo);
    assert.deepEqual(await routed.read(photoKey), photo);
    const pdf = await createReportPdf(reportEntry(photoId), routed);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.equal(await cloud.storage.exists(photoKey), false);
    await routed.save("media/new", Buffer.from("novo"));
    assert.equal((await routed.read("media/new")).toString(), "novo");
    await assert.rejects(
      cloud.storage.save("media/new", Buffer.from("again")),
      StorageConflictError,
    );
    assert.equal(await local.exists("media/new"), false);
    assert.equal(await routed.exists(photoKey), true);
    cloud.failReads(Object.assign(Error("forbidden"), { code: 403 }));
    await assert.rejects(routed.read(photoKey), /forbidden/);
    cloud.failReads();
    await assert.rejects(routed.read("media/absent"), StorageNotFoundError);
    await routed.delete(photoKey);
    assert.equal(await local.exists(photoKey), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("migração é verificável, idempotente e dry-run não grava", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-migration-"));
  try {
    const local = new LocalStorage(dir);
    const cloud = fakeCloud();
    const bytes = Buffer.from("imagem");
    const file = {
      key: "media/one",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mime: "image/jpeg",
    };
    await local.save(file.key, bytes);
    assert.equal(
      (await migrateFile(file, local, cloud.storage, true)).status,
      "would-copy",
    );
    assert.equal(await cloud.storage.exists(file.key), false);
    assert.equal(
      (await migrateFile(file, local, cloud.storage, false)).status,
      "copied",
    );
    assert.equal(
      (await migrateFile(file, local, cloud.storage, false)).status,
      "skipped",
    );
    assert.equal(await local.exists(file.key), true);
    await local.delete(file.key);
    assert.equal(
      (await migrateFile(file, cloud.storage, local, false)).status,
      "copied",
    );
    assert.equal((await local.read(file.key)).toString(), bytes.toString());
    assert.equal(
      (
        await migrateFile(
          { ...file, key: "media/missing" },
          local,
          cloud.storage,
          false,
        )
      ).status,
      "missing",
    );
    cloud.objects.set("media/bad", Buffer.from("incorrect"));
    assert.equal(
      (
        await migrateFile(
          { ...file, key: "media/bad" },
          local,
          cloud.storage,
          false,
        )
      ).status,
      "error",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function pdfTextPages(pdf: Buffer) {
  // Controlled PDFKit fixture using its built-in Helvetica fonts. Decode its
  // text operators without adding a production PDF parser dependency.
  return [
    ...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g),
  ]
    .map((match) => {
      let content: string;
      try {
        content = inflateSync(Buffer.from(match[1], "latin1")).toString(
          "latin1",
        );
      } catch {
        return [];
      }
      return [...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((operator) =>
        [...operator[1].matchAll(/<([0-9a-f]+)>/gi)]
          .map((token) => Buffer.from(token[1], "hex").toString("latin1"))
          .join(""),
      );
    })
    .filter((text) => text.length);
}

function pdfTextOperators(pdf: Buffer) {
  return pdfTextPages(pdf).flat();
}

test("PDF técnico mantém seções consecutivas de A a G, com peças em D", async () => {
  const entry = reportEntry(randomUUID());
  entry.payload.reasons = [];
  const pdf = await createReportPdf(entry, fakeCloud().storage);
  const text = pdfTextOperators(pdf);
  const titles = [
    "IDENTIFICAÇÃO",
    "EQUIPAMENTO",
    "MOTIVOS E SERVIÇOS",
    "PEÇAS UTILIZADAS / SOLICITADAS",
    "PENDÊNCIAS / PRÓXIMOS PASSOS",
    "CRONOGRAMA DE ATENDIMENTO",
    "STATUS FINAL",
  ];
  let previous = -1;
  titles.forEach((title, index) => {
    const position = text.indexOf(title);
    assert.ok(position > previous, `Seção ausente ou fora de ordem: ${title}`);
    assert.equal(text[position - 1], String.fromCharCode(65 + index), title);
    previous = position;
  });
  if (process.env.RENDER_REPORT_PDF) {
    await fs.mkdir(path.dirname(process.env.RENDER_REPORT_PDF), {
      recursive: true,
    });
    await fs.writeFile(process.env.RENDER_REPORT_PDF, pdf);
  }
});

test("PDF técnico preserva fotos, equipe e textos extensos com um cabeçalho e rodapé por página", async () => {
  const cloud = fakeCloud();
  const media: Record<
    string,
    {
      id: string;
      uri: string;
      name: string;
      createdAt: string;
      signerName?: string;
    }
  > = {};
  for (const [name, width, height] of [
    ["horizontal", 1000, 500],
    ["vertical", 360, 1200],
    ["panoramica", 1400, 250],
    ["assinatura-tecnico", 700, 200],
    ["assinatura-cliente", 700, 200],
  ] as const) {
    const id = randomUUID();
    const drawing = name.startsWith("assinatura")
      ? `<path d="M20,150 Q160,-60 220,140 T430,100 Q520,-20 660,130" fill="none" stroke="#20242c" stroke-width="5"/>`
      : `<rect width="100%" height="100%" fill="#dce6ec"/><rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#273b4b" stroke-width="5"/><text x="28" y="65" font-family="Arial" font-size="24">FOTO ${name.toUpperCase()}</text>`;
    const bytes = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${drawing}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    await cloud.storage.save(mediaStorageKey(id), bytes, "image/png");
    media[name] = {
      id,
      uri: `/api/media/${id}`,
      name: `${name}.png`,
      createdAt: "2026-11-12T14:35:00Z",
    };
  }
  const payload: Report = {
    ...newReport(),
    formRevision: 2,
    type: "externo",
    operator: "OPERADOR DE TESTE",
    requester: "REPRESENTANTE DO CLIENTE",
    location: "UNIDADE INDUSTRIAL - SETOR DE MOVIMENTACAO DE CARGAS",
    equipment: {
      type: "Guindaste",
      brand: "MARCA TESTE",
      model: "MODELO DE TESTE",
      serial: "SERIE-QA-2026",
      year: "2020",
      plate: "ABC1D23",
      fleet: "FROTA 05",
      odometer: "15000",
      hourmeterLower: "2300",
      hourmeterUpper: "1700",
    },
    reasons: [
      {
        id: "r1",
        description:
          "Verificar o sistema de acionamento e a movimentacao da lanca. Conferir as conexoes e registrar as condicoes observadas.",
        pending:
          "Programar revisao preventiva na proxima parada de manutencao.",
        services: [
          {
            id: "s1",
            description:
              "Realizada verificacao das conexoes, limpeza do conjunto e teste funcional. Equipamento acompanhado durante a operacao.",
            completed: "Sim",
            notes:
              "Teste realizado com acompanhamento do operador. As fotos registram as condicoes antes e depois do atendimento.",
            photos: [media.horizontal, media.vertical, media.panoramica],
          },
        ],
      },
      {
        id: "r2",
        description: "Conferencia dos comandos auxiliares.",
        pending: "",
        services: [
          {
            id: "s2",
            description:
              "Realizado teste dos comandos e orientacao ao operador.",
            notes: "",
            completed: "Sim",
            photos: [],
          },
        ],
      },
    ],
    parts: [
      {
        id: "p1",
        code: "PC-001",
        description:
          "Conjunto de vedacao para acionamento do sistema hidraulico",
        supplier: "FORNECEDOR DE TESTE",
        quantity: 2,
        kind: "replaced",
        codeHistory: [],
      },
      {
        id: "p2",
        code: "PC-002",
        description: "Filtro de retorno",
        supplier: "DISTRIBUIDOR INDUSTRIAL",
        quantity: 1,
        kind: "requested",
        codeHistory: [],
      },
    ],
    days: [0, 1].map((i) => ({
      ...newDay(`day-${i}`),
      date: `2026-11-${10 + i}`,
      notes:
        "Atendimento com dois profissionais. Validacoes realizadas junto ao cliente.",
      participants: [
        {
          technicianId: "tech-1",
          present: true,
          sameHoursAs: null,
          sameVehicleAs: null,
          odometerStart: "",
          odometerEnd: "",
          periods: [
            {
              id: `ida-${i}`,
              kind: "outbound" as const,
              start: "07:00",
              end: "08:00",
              pauseMinutes: "0",
              odometerStart: "100",
              odometerEnd: "125",
            },
            {
              id: `trabalho-${i}`,
              kind: "work" as const,
              start: "08:00",
              end: "12:00",
              pauseMinutes: "30",
              odometerStart: "N/A",
              odometerEnd: "N/A",
            },
            {
              id: `volta-${i}`,
              kind: "inbound" as const,
              start: "12:00",
              end: "13:00",
              pauseMinutes: "0",
              odometerStart: "125",
              odometerEnd: "150",
            },
          ],
        },
        {
          technicianId: "tech-2",
          present: true,
          sameHoursAs: "tech-1",
          sameVehicleAs: "tech-1",
          odometerStart: "",
          odometerEnd: "",
          periods: [],
        },
      ],
    })),
    concluded: "Sim",
    released: "Sim",
    observations:
      "Atendimento encerrado apos os testes. Cliente orientado sobre as pendencias e cuidados na operacao.",
    technicianSignature: {
      ...media["assinatura-tecnico"],
      signerName: "TECNICO RESPONSAVEL DE TESTE",
    },
    clientSignature: {
      ...media["assinatura-cliente"],
      signerName: "REPRESENTANTE DO CLIENTE DE TESTE",
    },
  };
  const entry: Entry = {
    ...reportEntry(media.horizontal.id),
    number: "QA-2026-12345",
    status: "finalized",
    technicianId: "tech-1",
    payload: {
      ...payload,
      clientSnapshot: {
        name: "CLIENTE DE TESTE INDUSTRIA E SERVICOS",
        identifier: "12345678000190",
      },
      technicianSnapshot: { name: "TECNICO RESPONSAVEL DE TESTE" },
      teamSnapshot: [
        {
          technicianId: "tech-1",
          name: "TECNICO RESPONSAVEL DE TESTE",
          role: "technician",
          charged: "Sim",
        },
        {
          technicianId: "tech-2",
          name: "PROFISSIONAL AUXILIAR DE TESTE",
          role: "auxiliary",
          charged: "Não",
        },
      ],
    },
  };
  for (const variant of ["completo", "textos-longos"]) {
    const record = structuredClone(entry);
    if (variant === "textos-longos") {
      record.payload.location =
        "Descricao extensa da unidade e do local de atendimento. ".repeat(160) +
        "\nFIM DO LOCAL EXTENSO";
      record.payload.technicianSignature.signerName =
        "TECNICO COM NOME COMPLETO PARA TESTAR QUEBRA DE LINHA NA ASSINATURA";
      record.payload.reasons[0].description =
        "Texto extenso com todas as observacoes do atendimento. ".repeat(180) +
        "\nFIM DO MOTIVO EXTENSO";
      record.payload.observations =
        "Registro complementar de todas as verificacoes realizadas no equipamento. ".repeat(
          150,
        ) + "\nFIM DAS OBSERVACOES EXTENSAS";
    }
    const pdf = await createReportPdf(record, cloud.storage);
    const text = pdfTextOperators(pdf);
    const pages = [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)]
      .length;
    assert.ok(pages >= 3);
    assert.equal(text.filter((line) => line === "BR LIFT").length, pages);
    assert.equal(text.filter((line) => line.startsWith("Pág. ")).length, pages);
    const isBodyLine = (line: string) =>
      !line.startsWith("BR LIFT") &&
      !line.startsWith("Pág. ") &&
      line !== `Atendimento ${record.number}` &&
      line !== "continuação" &&
      line !== "RELATÓRIO DE ATENDIMENTO TÉCNICO" &&
      line !== `O.S. OMIE ${record.number}`;
    const headers = [
      "IDENTIFICAÇÃO",
      "EQUIPAMENTO",
      "MOTIVOS E SERVIÇOS",
      "PEÇAS UTILIZADAS / SOLICITADAS",
      "PENDÊNCIAS / PRÓXIMOS PASSOS",
      "CRONOGRAMA DE ATENDIMENTO",
      "STATUS FINAL",
    ];
    for (const lines of pdfTextPages(pdf)) {
      const body = lines.filter(isBodyLine);
      assert.ok(body.length, "Página sem conteúdo");
      assert.ok(
        !headers.includes(body.at(-1)!),
        "Título isolado no fim da página",
      );
    }
    const normalized = text.filter(isBodyLine).join("").replace(/\s+/g, "");
    for (const phrase of [
      record.payload.reasons[0].description,
      record.payload.observations,
      record.payload.location,
      record.payload.technicianSignature.signerName,
      "TECNICO RESPONSAVEL DE TESTE",
      "REPRESENTANTE DO CLIENTE DE TESTE",
      "SERIE-QA-2026",
      "PC-001",
      "PC-002",
      "Trabalho 14:00",
      "Deslocamento 08:00",
      "KM 100",
    ])
      assert.ok(
        normalized.includes(phrase.replace(/\s+/g, "")),
        `Texto perdido: ${phrase.slice(-60)}`,
      );
    for (const image of Object.values(media))
      assert.ok(cloud.reads.includes(mediaStorageKey(image.id)));
    if (process.env.RENDER_REPORT_REVIEW_DIR) {
      await fs.mkdir(process.env.RENDER_REPORT_REVIEW_DIR, { recursive: true });
      await fs.writeFile(
        path.join(process.env.RENDER_REPORT_REVIEW_DIR, `${variant}.pdf`),
        pdf,
      );
    }
  }
});

test("PDF de atendimento usa foto lida pelo adaptador GCS", async () => {
  const cloud = fakeCloud();
  await cloud.storage.assertPrivateBucket();
  const id = randomUUID();
  const key = mediaStorageKey(id);
  const photo = await sharp({
    create: { width: 240, height: 160, channels: 3, background: "#f6d252" },
  })
    .jpeg()
    .toBuffer();
  await cloud.storage.save(key, photo, "image/jpeg");
  const pdf = await createReportPdf(
    reportEntry(id),
    new RoutedStorage(cloud.storage, [cloud.storage]),
  );
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > photo.length);
  assert.ok(cloud.reads.includes(key));
});

test("DOCX de inspeção lê foto pelo GCS", async () => {
  const cloud = fakeCloud();
  const id = randomUUID();
  const photo = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#4dca87" },
  })
    .jpeg()
    .toBuffer();
  await cloud.storage.save(mediaStorageKey(id), photo, "image/jpeg");
  const docx = await documentForRecord(
    inspectionEntry(id),
    "docx",
    cloud.storage,
  );
  const zip = await JSZip.loadAsync(docx);
  assert.ok(
    Object.keys(zip.files).some((name) =>
      name.startsWith("word/media/stg-img_013"),
    ),
  );
  assert.ok(cloud.reads.includes(mediaStorageKey(id)));
});

test(
  "PDF de inspeção converte DOCX com foto do GCS",
  { skip: !process.env.RUN_STORAGE_PDF },
  async () => {
    const cloud = fakeCloud();
    const id = randomUUID();
    const photo = await sharp({
      create: { width: 160, height: 120, channels: 3, background: "#4dca87" },
    })
      .jpeg()
      .toBuffer();
    await cloud.storage.save(mediaStorageKey(id), photo, "image/jpeg");
    const pdf = await documentForRecord(
      inspectionEntry(id),
      "pdf",
      cloud.storage,
    );
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(cloud.reads.includes(mediaStorageKey(id)));
  },
);
