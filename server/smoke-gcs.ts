import "dotenv/config";

import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { Entry } from "../contracts/domain.js";
import { documentForRecord } from "./documents.js";
import { parseStorageConfig } from "./object-storage/config.js";
import { GoogleCloudStorage } from "./object-storage/gcs.js";
import { mediaStorageKey } from "./object-storage/index.js";

async function main() {
  const { gcsBucket } = parseStorageConfig();
  if (!gcsBucket) throw Error("Defina GCS_BUCKET para o smoke test.");
  const gcs = new GoogleCloudStorage(gcsBucket);
  await gcs.assertPrivateBucket();
  const id = randomUUID();
  const key = mediaStorageKey(id);
  const photo = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#4dca87" },
  }).jpeg().toBuffer();
  await gcs.save(key, photo, "image/jpeg");
  try {
    const now = new Date().toISOString();
    const entry: Entry = {
      id: "gcs-smoke", kind: "inspections", number: "SMOKE",
      clientId: null, technicianId: null, equipmentId: null,
      date: now.slice(0, 10), status: "draft", version: 1,
      createdAt: now, updatedAt: now,
      payload: {
        id: "gcs-smoke", name: "Teste GCS", createdAt: now, updatedAt: now,
        documentFields: {}, sections: [],
        documentImages: { "013": [{ id, uri: `/api/media/${id}`, name: "smoke.jpg", createdAt: now }] },
      },
    };
    const pdf = await documentForRecord(entry, "pdf", gcs);
    if (pdf.subarray(0, 4).toString() !== "%PDF")
      throw Error("PDF inválido.");
    console.log(`GCS privado, foto e PDF verificados (${pdf.length} bytes).`);
  } finally {
    await gcs.delete(key);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
