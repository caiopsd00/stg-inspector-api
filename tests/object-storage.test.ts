import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import JSZip from "jszip";

import { newReport, type Entry } from "../contracts/domain.js";
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
