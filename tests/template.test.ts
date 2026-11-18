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
import { newDay } from "../contracts/domain.js";
import type { InspectionImage } from "../contracts/types.js";

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

test("inspeção inclui identificação, totais, fotos complementares e assinaturas sem CPF", async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-signers-"));
  const previousStorage = process.env.STORAGE_DIR;
  try {
    process.env.STORAGE_DIR = storage;
    await fs.mkdir(path.join(storage, "media"));
    const technicianId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const image = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="250"><path d="M20,200 Q200,-180 280,190 T500,120 Q630,-60 700,140 T880,80" fill="none" stroke="#142442" stroke-width="8"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await Promise.all(
      [technicianId, clientId].map((id) =>
        fs.writeFile(path.join(storage, "media", id), image),
      ),
    );
    const documentImages: Record<string, InspectionImage[]> = {};
    for (const slot of ["126_1", "127_1", "148_1", "150_1"]) {
      documentImages[slot] = [];
      for (let index = 0; index < (slot === "126_1" ? 2 : 1); index++) {
        const id = crypto.randomUUID();
        const photo = await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="260"><rect width="800" height="260" fill="#dde6ed"/><text x="30" y="130" font-family="Arial" font-size="30" fill="#142442">FOTO COMPLEMENTAR ${slot} - ${index + 1}</text></svg>`,
          ),
        )
          .png()
          .toBuffer();
        await fs.writeFile(path.join(storage, "media", id), photo);
        documentImages[slot].push({
          id,
          uri: `/api/media/${id}`,
          name: `complementar-${slot}-${index + 1}.png`,
          createdAt: "2026-11-12T12:00:00Z",
        });
      }
    }
    const photoFixture = async (
      label: string,
      width: number,
      height: number,
    ) => {
      const id = crypto.randomUUID();
      const bytes = await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#dbe7eb"/><rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="none" stroke="#17354a" stroke-width="8"/><text x="25" y="70" font-family="Arial" font-size="24" fill="#17354a">${label}</text></svg>`,
        ),
      )
        .png()
        .toBuffer();
      await fs.writeFile(path.join(storage, "media", id), bytes);
      return {
        id,
        uri: `/api/media/${id}`,
        name: `${label}.png`,
        createdAt: "2026-11-12T12:00:00Z",
      };
    };
    documentImages["013"] = [
      await photoFixture("VERTICAL 1", 360, 1200),
      await photoFixture("VERTICAL 2", 360, 1200),
    ];
    documentImages["014"] = [await photoFixture("DADOS TECNICOS", 900, 300)];
    const sections = createTemplateSections();
    for (const item of sections.flatMap((section) => section.items))
      item.situation = "A";
    Object.assign(sections[0].items[0], {
      situation: "C",
      observation: "Falha < A & B\nNova linha STG {{x}}",
    });
    Object.assign(sections[0].items[1], {
      situation: "C",
      observation: "Outra falha",
    });
    sections[0].items[2].images = [
      await photoFixture("ITEM VERTICAL", 360, 1200),
    ];
    const inspection = {
      id: "test-inspection",
      name: "Teste",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      documentFields: {
        "000": "OMIE-401",
        "001": "Guindaste",
        "002": "MODELO QA",
        "003": "SERIE-QA-27",
        "004": "80 T",
        "005": "2020",
        "008": "ABC1D23",
        equipmentBrand: "MARCA DE TESTE",
        equipmentPlate: "ABC1D23",
        equipmentFleet: "FROTA-009",
        "006": "50",
        "007": "80",
        hourmeterUpper: "72",
        "011": "Rejeitada",
        "164": "Técnico Teste",
        "165": "Supervisor QA",
      },
      documentImages,
      sections,
      days: [
        {
          ...newDay(crypto.randomUUID()),
          date: "2026-11-08",
          notes: "TURNO DA MANHÃ",
          periods: [
            {
              id: crypto.randomUUID(),
              kind: "outbound" as const,
              start: "07:00",
              end: "08:00",
              pauseMinutes: "0",
              odometerStart: "100",
              odometerEnd: "125",
            },
            {
              id: crypto.randomUUID(),
              kind: "work" as const,
              start: "08:00",
              end: "12:00",
              pauseMinutes: "15",
              odometerStart: "0",
              odometerEnd: "N/A",
            },
          ],
        },
        {
          ...newDay("second-day"),
          date: "2026-11-09",
          notes: "SEGUNDO DIA",
          periods: [
            {
              id: "second-work",
              kind: "work" as const,
              start: "13:00",
              end: "14:00",
              pauseMinutes: "0",
              odometerStart: "125",
              odometerEnd: "130",
            },
          ],
        },
      ],
      technicianSnapshot: { name: "Técnico Teste", identifier: "12345678901" },
      clientSnapshot: { name: "Cliente Exemplo", identifier: "12345678000190" },
      technicianSignature: {
        id: technicianId,
        uri: `/api/media/${technicianId}`,
        name: "tecnico.png",
        createdAt: "2026-11-10T15:22:01Z",
        signerName: "TÉCNICO SIGNATÁRIO",
      },
      clientSignature: {
        id: clientId,
        uri: `/api/media/${clientId}`,
        name: "cliente.png",
        createdAt: "2026-11-10T17:33:01Z",
        signerName: "CLIENTE SIGNATÁRIO",
      },
    };
    const docx = await createInspectionDocxAsync(inspection);
    const zip = await JSZip.loadAsync(docx);
    assert.ok(zip.file("word/media/brlift-brand.png"));
    assert.match(
      await zip.file("[Content_Types].xml")!.async("string"),
      /Extension="png" ContentType="image\/png"/,
    );
    const header = await zip.file("word/header1.xml")!.async("string");
    assert.match(header, /r:embed="rIdBRLiftBrand"/);
    assert.match(header, /name="BR LIFT"/);
    assert.match(header, /w:color="CAE211"/);
    const headerRelationships = await zip
      .file("word/_rels/header1.xml.rels")!
      .async("string");
    assert.match(
      headerRelationships,
      /Id="rIdBRLiftBrand".*Target="media\/brlift-brand.png"/,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    const technicianLabel = xml.indexOf("Assinatura do técnico");
    const technicianIdentity = xml.indexOf("TÉCNICO SIGNATÁRIO");
    const clientLabel = xml.indexOf("Assinatura do cliente");
    const clientIdentity = xml.indexOf("CLIENTE SIGNATÁRIO");
    assert.ok(technicianLabel > 0 && technicianLabel < technicianIdentity);
    assert.ok(technicianIdentity < clientLabel && clientLabel < clientIdentity);
    assert.match(
      xml.slice(technicianIdentity, clientLabel),
      /10\/11\/2026.*12:22/,
    );
    assert.match(xml.slice(clientIdentity), /10\/11\/2026.*14:33/);
    assert.match(xml.slice(clientIdentity), /Representante do cliente/);
    assert.doesNotMatch(xml, /12345678901|\bCPF\b|GUINDASTE – Guindaste/);
    assert.match(xml, /Cliente Exemplo/);
    assert.match(xml, /12\.345\.678\/0001-90/);
    assert.match(xml, /MARCA DE TESTE/);
    assert.match(xml, /ABC1D23/);
    assert.match(xml, /FROTA-009/);
    assert.match(
      xml,
      /Resumo do dia: Trabalho líquido 225 min · Deslocamento líquido 60 min · Quilometragem total 25/,
    );
    assert.match(
      xml,
      /Trabalho líquido: 285 min · Deslocamento líquido: 60 min · Quilometragem total: 30/,
    );
    assert.match(
      xml,
      /<w:br\/><w:t xml:space="preserve">Observação: Falha &lt; A &amp; B/,
    );
    assert.match(
      xml,
      /Nova linha STG \{\{x\}\}<\/w:t><w:br\/><w:t xml:space="preserve"><\/w:t><w:br\/><w:t xml:space="preserve">016 -/,
    );
    assert.match(xml, /não está apto/);
    assert.ok(
      xml.indexOf("CRONOGRAMA DE INSPEÇÃO") <
        xml.indexOf("Registro de inspeção diária"),
    );
    assert.match(xml, /Quilometragem inicial: 0 · Quilometragem final: N\/A/);
    assert.match(xml, /HORÍMETRO INFERIOR.*HORÍMETRO SUPERIOR/);
    assert.match(xml, /QUILOMETRAGEM/);
    assert.doesNotMatch(xml, /QUILOMETRAGEM\*/);
    assert.doesNotMatch(xml, /Hor\. Inferior|Hor\. Superior|REGISTRO ANTERIOR/);
    assert.match(xml, /<w:pgMar\b[^>]*w:top="1620"[^>]*w:bottom="1440"/);
    assert.doesNotMatch(xml, /<w:trHeight\b[^>]*w:hRule="exact"/);
    const imageParagraphs = [
      ...xml.matchAll(/<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g),
    ]
      .map((match) => match[0])
      .filter((paragraph) => paragraph.includes("<w:drawing>"));
    assert.equal(imageParagraphs.length, 11);
    for (const paragraph of imageParagraphs) {
      assert.match(paragraph, /<w:spacing w:before="160" w:after="160"/);
      assert.match(paragraph, /<w:jc w:val="center"\/>/);
      assert.match(paragraph, /<w:keepLines\/>/);
    }
    for (const match of xml.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)) {
      const row = match[0];
      if (row.includes("<w:drawing>")) assert.match(row, /<w:cantSplit\/>/);
      if (/FOTOGRAFIA DO EQUIPAMENTO|DADOS TÉCNICOS DO EQUIPAMENTO/.test(row))
        assert.match(row, /<w:keepNext\/>/);
    }
    const scheduleStart = xml.indexOf("CRONOGRAMA DE INSPEÇÃO");
    const scheduleGap = xml.slice(
      xml.lastIndexOf("</w:tbl>", scheduleStart) + 8,
      scheduleStart,
    );
    assert.equal([...scheduleGap.matchAll(/<w:p\b/g)].length, 2);
    const signatureStart = xml.indexOf("RESULTADO E ASSINATURAS DA INSPEÇÃO");
    const signatureGap = xml.slice(
      xml.lastIndexOf("</w:tbl>", signatureStart) + 8,
      signatureStart,
    );
    assert.equal([...signatureGap.matchAll(/<w:p\b/g)].length, 1);
    const tables = [...xml.matchAll(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g)].map(
      (match) => match[0],
    );
    const resultTable = tables.find((table) =>
      table.includes("Inspeção realizada por:"),
    );
    assert.ok(resultTable);
    const resultRows = [
      ...resultTable.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g),
    ].map((match) => match[0]);
    assert.equal(resultRows.length, 3);
    for (const [index, expected] of [
      ["Resultado da vistoria:", "Rejeitada"],
      ["Inspeção realizada por:", "Técnico Teste"],
      ["Inspeção aprovada por:", "Supervisor QA"],
    ].entries()) {
      const cells = [
        ...resultRows[index].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g),
      ].map((match) => match[0]);
      assert.equal(cells.length, 2);
      cells.forEach((cell, i) => {
        assert.ok(cell.includes(expected[i]));
        assert.match(cell, /<w:vAlign w:val="center"\/>/);
        assert.match(cell, /<w:jc w:val="center"\/>/);
        assert.match(cell, /<w:tcW w:w="4665" w:type="dxa"\/>/);
      });
      assert.match(resultRows[index], /<w:cantSplit\/>/);
      assert.match(resultRows[index], /w:hRule="atLeast"/);
    }
    assert.equal(xml.split("Inspeção realizada por:").length - 1, 1);
    assert.ok(xml.includes("Total do item: 3h45min líquidos · N/A km"));
    assert.ok(xml.includes("Total do item: 1h00min líquidos · 5 km"));
    assert.ok(xml.indexOf(resultTable) < technicianLabel);
    const checklistTables = tables.filter((table) =>
      table.includes('<w:tblW w:w="9465"'),
    );
    assert.equal(checklistTables.length, 15);
    for (const table of checklistTables) {
      assert.match(table, /<w:tblLayout w:type="fixed"\/>/);
      const grid = /<w:tblGrid>[\s\S]*?<\/w:tblGrid>/.exec(table)![0];
      const widths = [...grid.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(
        (match) => Number(match[1]),
      );
      assert.equal(widths[0], 810);
      assert.equal(widths.at(-1), 1290);
      assert.equal(
        widths.slice(1, -1).reduce((sum, width) => sum + width, 0),
        7365,
      );
      for (const row of table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)) {
        let column = 0;
        for (const cell of row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)) {
          const span = Number(
            /<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(cell[0])?.[1] || 1,
          );
          const width = Number(/<w:tcW w:w="(\d+)"/.exec(cell[0])![1]);
          assert.equal(
            width,
            widths
              .slice(column, column + span)
              .reduce((sum, value) => sum + value, 0),
          );
          column += span;
        }
        assert.equal(column, widths.length);
      }
    }
    const closing = xml.slice(xml.lastIndexOf("<w:p>", signatureStart));
    assert.doesNotMatch(closing, /<w:pageBreakBefore\b/);
    const opinion = [...xml.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)].find(
      (row) => row[0].includes("não está apto"),
    )![0];
    assert.match(opinion, /<w:cantSplit\/>/);
    assert.equal([...opinion.matchAll(/<w:p\b/g)].length, 2);
    for (const label of ["Assinatura do técnico", "Assinatura do cliente"]) {
      const start = xml.lastIndexOf("<w:p>", xml.indexOf(label));
      const paragraphs = [
        ...xml.slice(start).matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g),
      ]
        .slice(0, 3)
        .map((match) => match[0]);
      assert.equal(paragraphs.length, 3);
      paragraphs.forEach((paragraph) =>
        assert.match(paragraph, /<w:keepLines\/>/),
      );
      assert.match(paragraphs[0], /<w:keepNext\/>/);
      assert.match(paragraphs[1], /<w:keepNext\/>/);
      assert.doesNotMatch(paragraphs[2], /<w:keepNext\/>/);
    }
    assert.ok(!xml.includes("{#img_customer_signature}"));
    const media = Object.keys(zip.files).filter((name) =>
      name.startsWith("word/media/stg-img_"),
    );
    assert.ok(media.some((name) => name.includes("img_technician_signature")));
    assert.ok(media.some((name) => name.includes("img_customer_signature")));
    for (const slot of Object.keys(documentImages))
      assert.equal(
        media.filter((name) => name.includes(`stg-img_${slot}-`)).length,
        documentImages[slot].length,
      );
    if (process.env.RENDER_TEST_DOCX)
      await fs.writeFile(process.env.RENDER_TEST_DOCX, docx);

    // Explicit selection takes precedence; only finalized legacy documents without
    // a selection use the critical-item fallback. A draft never implies release.
    for (const [result, finalizedAt, expected] of [
      ["Aprovada", inspection.finalizedAt, /está apto/],
      ["", inspection.finalizedAt, /não está apto/],
      ["", undefined, /está com avaliação incompleta/],
    ] as const) {
      const file = await JSZip.loadAsync(
        await createInspectionDocxAsync({
          ...inspection,
          finalizedAt,
          documentFields: { ...inspection.documentFields, "011": result },
          technicianSignature: undefined,
          clientSignature: undefined,
        }),
      );
      const rendered = await file.file("word/document.xml")!.async("string");
      assert.match(rendered, expected);
      if (result === "Aprovada") assert.doesNotMatch(rendered, /não está apto/);
    }
  } finally {
    if (previousStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorage;
    await fs.rm(storage, { recursive: true, force: true });
  }
});

test("inspeção antiga mantém a placa/frota combinada sem inferir dados do cadastro atual", async () => {
  const docx = await createInspectionDocxAsync({
    id: "legacy",
    name: "Legado",
    createdAt: "",
    updatedAt: "",
    documentFields: {
      "008": "IDENTIFICADOR LEGADO",
      "002": "MODELO ANTIGO",
      "006": "6262",
      hourmeterUpper: "1245123",
      "007": "37272",
    },
    documentImages: {},
    sections: createTemplateSections(),
  });
  const xml = await (
    await JSZip.loadAsync(docx)
  )
    .file("word/document.xml")!
    .async("string");
  assert.match(xml, /N° da PLACA \/ FROTA/);
  assert.match(xml, /HORÍMETRO INFERIOR.*HORÍMETRO SUPERIOR/);
  assert.match(xml, /QUILOMETRAGEM/);
  assert.doesNotMatch(xml, /QUILOMETRAGEM\*/);
  assert.doesNotMatch(xml, /REGISTRO ANTERIOR|Hor\. Inferior|Hor\. Superior/);
  assert.match(xml, /IDENTIFICADOR LEGADO/);
  assert.doesNotMatch(xml, /<w:t>PLACA<\/w:t>|<w:t>FROTA<\/w:t>/);
  if (process.env.RENDER_TEST_LEGACY_DOCX)
    await fs.writeFile(process.env.RENDER_TEST_LEGACY_DOCX, docx);
});
