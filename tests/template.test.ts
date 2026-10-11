import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import sharp from "sharp";
import { cleanInspectionTemplateXml } from "../contracts/inspection-template-cleanup.js";
import { createTemplateSections } from "../contracts/inspection-template.js";
import { createInspectionDocxAsync } from "../server/inspection-docx.js";

test("template mantém itens e limites, sem laudos, diagnósticos ou medições de exemplo", async () => {
  const source = await JSZip.loadAsync(
    await fs.readFile("template/inspecao-final-assinatura.docx"),
  );
  const before = await source.file("word/document.xml")!.async("string");
  const after = cleanInspectionTemplateXml(before);
  const text = after.replace(/<[^>]+>/g, "");
  for (const value of [
    "MALURE",
    "ML-32021110",
    "19mm",
    "17 MM",
    "INOPERANTE",
    "DESCALIBRADOS",
    "CALIBRAR ÂNGULO",
    "0,5mm",
    "44,20 Graus",
    "22,3 Metros",
  ])
    assert.ok(!text.includes(value), value);
  assert.ok(text.includes("1,2mm"));
  assert.ok(text.includes("&gt;2mm"));
  assert.deepEqual(
    after.match(/\{\{[^}]+\}\}/g),
    before.match(/\{\{[^}]+\}\}/g),
  );
  assert.deepEqual(
    after.match(/\{#img_[^}]+\}/g),
    before.match(/\{#img_[^}]+\}/g),
  );
  const items = createTemplateSections().flatMap((s) => s.items);
  assert.equal(
    items.find((i) => i.code === "152")!.name,
    "0° — medição da folga axial",
  );
  assert.ok(!items.some((i) => i.name.includes("MALURE")));
});

test("documento inclui duas assinaturas em sequência com nome e documento dos signatários", async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-signers-"));
  const previousStorage = process.env.STORAGE_DIR;
  try {
    process.env.STORAGE_DIR = storage;
    await fs.mkdir(path.join(storage, "media"));
    const technicianId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const image = await sharp({
      create: { width: 900, height: 250, channels: 4, background: "#fff" },
    })
      .png()
      .toBuffer();
    await Promise.all(
      [technicianId, clientId].map((id) =>
        fs.writeFile(path.join(storage, "media", id), image),
      ),
    );
    const docx = await createInspectionDocxAsync({
      id: "test-inspection",
      name: "Teste",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      documentFields: { "011": "Aprovada", "164": "Técnico Teste" },
      documentImages: {},
      sections: [],
      technicianSnapshot: { name: "Técnico Teste", identifier: "12345678901" },
      clientSnapshot: { name: "Cliente Exemplo", identifier: "12345678000190" },
      technicianSignature: {
        id: technicianId,
        uri: `/api/media/${technicianId}`,
        name: "tecnico.png",
        createdAt: new Date().toISOString(),
      },
      clientSignature: {
        id: clientId,
        uri: `/api/media/${clientId}`,
        name: "cliente.png",
        createdAt: new Date().toISOString(),
      },
    });
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file("word/document.xml")!.async("string");
    const technicianLabel = xml.indexOf("Assinatura do técnico");
    const technicianIdentity = xml.indexOf("CPF: 12345678901");
    const clientLabel = xml.indexOf("Assinatura do cliente");
    const clientIdentity = xml.indexOf("CNPJ: 12345678000190");
    assert.ok(technicianLabel > 0 && technicianLabel < technicianIdentity);
    assert.ok(technicianIdentity < clientLabel && clientLabel < clientIdentity);
    assert.ok(xml.includes("Nome: Técnico Teste"));
    assert.ok(xml.includes("Cliente: Cliente Exemplo"));
    assert.ok(xml.includes("<w:pageBreakBefore/>"));
    assert.ok(!xml.includes("{#img_customer_signature}"));
    const media = Object.keys(zip.files).filter((name) =>
      name.startsWith("word/media/stg-img_"),
    );
    assert.ok(media.some((name) => name.includes("img_technician_signature")));
    assert.ok(media.some((name) => name.includes("img_customer_signature")));
    if (process.env.RENDER_TEST_DOCX)
      await fs.writeFile(process.env.RENDER_TEST_DOCX, docx);
  } finally {
    if (previousStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorage;
    await fs.rm(storage, { recursive: true, force: true });
  }
});
