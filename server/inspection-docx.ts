import fs from "node:fs/promises";
import { cleanInspectionTemplateXml } from "../contracts/inspection-template-cleanup.js";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import {
  Inspection,
  InspectionImage,
  InspectionItem,
} from "../contracts/types.js";
import { normalizeInspectionResult } from "../contracts/inspection-template.js";
const DOCUMENT_XML_PATH = "word/document.xml";
const DOCUMENT_RELS_PATH = "word/_rels/document.xml.rels";
const EMU_PER_INCH = 914400;

type ImageReplacement = {
  dataUrl: string;
  extension: "jpg" | "png";
  heightInches: number;
  key: string;
  widthInches: number;
};

type ImageBounds = {
  heightInches: number;
  widthInches: number;
};

type PixelSize = {
  height: number;
  width: number;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value?: string) {
  return escapeXml(value?.trim() || "");
}

function dataUrlToBase64(dataUrl: string) {
  return dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
}

function getImageExtension(dataUrl: string): "jpg" | "png" {
  return dataUrl.includes("image/jpeg") || dataUrl.includes("image/jpg")
    ? "jpg"
    : "png";
}

function fitImageWithinBounds(
  size: PixelSize | undefined,
  bounds: ImageBounds,
) {
  if (!size?.width || !size.height) {
    return bounds;
  }

  const ratio = size.width / size.height;
  let widthInches = bounds.widthInches;
  let heightInches = widthInches / ratio;

  if (heightInches > bounds.heightInches) {
    heightInches = bounds.heightInches;
    widthInches = heightInches * ratio;
  }

  return {
    heightInches,
    widthInches,
  };
}

async function getImagePixelSizeAsync(image: InspectionImage) {
  const bytes = await imageBytes(image.uri);
  const size = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
  return { width: size.width!, height: size.height! };
}
async function imageBytes(uri: string) {
  const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(uri);
  if (!match) throw Error("Referência de imagem inválida.");
  return fs.readFile(
    path.resolve(process.env.STORAGE_DIR || "storage", "media", match[1]),
  );
}
async function readFileAsBase64DataUrlAsync(uri: string) {
  const bytes = await imageBytes(uri);
  return (
    "data:image/" +
    (bytes[0] === 255 ? "jpeg" : "png") +
    ";base64," +
    bytes.toString("base64")
  );
}
function getField(inspection: Inspection, key: string) {
  return inspection.documentFields[key]?.trim() || "";
}

function getAllItems(inspection: Inspection) {
  return inspection.sections.flatMap((section) =>
    section.items.map((item) => ({
      sectionName: section.name,
      item,
    })),
  );
}

function getComputedInspectionResult(inspection: Inspection) {
  const items = getAllItems(inspection);

  if (items.some(({ item }) => item.situation === "C")) {
    return "Rejeitada";
  }

  if (items.some(({ item }) => item.situation === "B")) {
    return "Aprovada";
  }

  return "Aprovada";
}

function formatNonConformities(
  items: { sectionName: string; item: InspectionItem }[],
) {
  if (!items.length) {
    return "Nenhum item registrado.";
  }

  return items
    .map(({ item, sectionName }) => {
      const observation = item.observation.trim()
        ? ` - ${item.observation.trim()}`
        : "";
      return `${item.code} - ${item.name} (${sectionName})${observation}`;
    })
    .join("\n");
}

function buildTextValues(inspection: Inspection) {
  const values: Record<string, string> = {};
  const allItems = getAllItems(inspection);
  const criticalItems = allItems.filter(({ item }) => item.situation === "C");
  const maintenanceItems = allItems.filter(
    ({ item }) => item.situation === "B",
  );
  const result = getComputedInspectionResult(inspection);

  Object.entries(inspection.documentFields).forEach(([key, value]) => {
    values[key] = value;
  });
  values["009"] =
    inspection.technicianSnapshot?.name ||
    getField(inspection, "164") ||
    getField(inspection, "009");
  values["164"] = values["009"];
  values["011"] =
    normalizeInspectionResult(getField(inspection, "011")) || result;

  inspection.sections.forEach((section) => {
    section.items.forEach((item) => {
      values[`s_${item.code}`] = item.situation || "";
      values[`o_${item.code}`] = item.observation || "";
    });
  });

  values["156"] = formatNonConformities(criticalItems);
  values["157"] = formatNonConformities(maintenanceItems);
  values["158"] = getField(inspection, "002") || getField(inspection, "001");
  values["159"] = getField(inspection, "008");
  values["160"] = getField(inspection, "003");
  values["161"] = values["011"] === "Rejeitada" ? "não está apto" : "está apto";
  values["162"] = criticalItems.length
    ? "As falhas críticas listadas devem ser corrigidas antes da liberação operacional."
    : maintenanceItems.length
      ? "Os itens classificados como B devem entrar na programação de manutenção e reparo."
      : "Não foram identificadas não conformidades impeditivas no momento da inspeção.";
  values["163"] = "";
  if (!inspection.finalizedAt || allItems.some(({ item }) => !item.situation)) {
    values["011"] = "Em andamento - rascunho";
    values["161"] = "está com avaliação incompleta";
    values["162"] =
      "Inspeção não finalizada. Este rascunho não comprova liberação operacional.";
  }

  return values;
}

function replaceTextPlaceholders(xml: string, values: Record<string, string>) {
  return xml.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) =>
    normalizeText(values[key]),
  );
}

function getNextRelationshipId(relsXml: string) {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) =>
    Number(match[1]),
  );
  return Math.max(0, ...ids) + 1;
}

function appendImageRelationship(
  relsXml: string,
  relationshipId: string,
  target: string,
) {
  const relationship = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  return relsXml.replace("</Relationships>", `${relationship}</Relationships>`);
}

function createImageParagraph(
  relationshipId: string,
  widthInches: number,
  heightInches: number,
) {
  const cx = Math.round(widthInches * EMU_PER_INCH);
  const cy = Math.round(heightInches * EMU_PER_INCH);
  const docPrId =
    Math.floor(Date.now() % 100000) + Math.floor(Math.random() * 1000);

  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="Imagem STG"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Imagem STG"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function removeImageBlock(xml: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paragraphWithText = (textPattern: string) =>
    `<w:p\\b(?:(?!<\\/w:p>)[\\s\\S])*?<w:t[^>]*>\\s*${textPattern}\\s*<\\/w:t>(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>`;
  const pattern = new RegExp(
    `${paragraphWithText(`\\{#${escapedKey}\\}`)}\\s*${paragraphWithText("\\{%image\\}")}\\s*${paragraphWithText(`\\{\\/${escapedKey}\\}`)}`,
    "g",
  );

  return xml.replace(pattern, "<w:p><w:r/></w:p>");
}

function removeTemplateImageParagraphs(xml: string) {
  const tokenParagraph =
    "<w:p\\b(?:(?!<\\/w:p>)[\\s\\S])*?<w:t[^>]*>\\s*(?:\\{#img_[^}]+\\}|\\{%image\\}|\\{\\/img_[^}]+\\})\\s*<\\/w:t>(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>";

  return xml.replace(new RegExp(tokenParagraph, "g"), "<w:p><w:r/></w:p>");
}

function replaceImageBlock(xml: string, key: string, paragraphXml: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paragraphWithText = (textPattern: string) =>
    `<w:p\\b(?:(?!<\\/w:p>)[\\s\\S])*?<w:t[^>]*>\\s*${textPattern}\\s*<\\/w:t>(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>`;
  const pattern = new RegExp(
    `${paragraphWithText(`\\{#${escapedKey}\\}`)}\\s*${paragraphWithText("\\{%image\\}")}\\s*${paragraphWithText(`\\{\\/${escapedKey}\\}`)}`,
    "g",
  );

  return xml.replace(pattern, paragraphXml);
}

async function imageToReplacement(
  key: string,
  image: InspectionImage | undefined,
  bounds: ImageBounds,
) {
  if (!image) {
    return undefined;
  }

  const dataUrl = await readFileAsBase64DataUrlAsync(image.uri);
  const dimensions = fitImageWithinBounds(
    await getImagePixelSizeAsync(image),
    bounds,
  );

  return {
    dataUrl,
    extension: getImageExtension(dataUrl),
    heightInches: dimensions.heightInches,
    key,
    widthInches: dimensions.widthInches,
  };
}

async function buildImageReplacements(inspection: Inspection) {
  const replacements: ImageReplacement[] = [];
  const addImageReplacements = async (
    key: string,
    images: InspectionImage[] | undefined,
    bounds: ImageBounds,
  ) => {
    for (const image of images || []) {
      const replacement = await imageToReplacement(key, image, bounds);

      if (replacement) {
        replacements.push(replacement);
      }
    }
  };

  await addImageReplacements("img_013", inspection.documentImages["013"], {
    widthInches: 5.8,
    heightInches: 3.2,
  });
  await addImageReplacements("img_014", inspection.documentImages["014"], {
    widthInches: 5.8,
    heightInches: 3.2,
  });

  for (const section of inspection.sections) {
    for (const item of section.items) {
      const imageSlots = [
        `img_${item.code}`,
        ...(item.extraImageSlots || []).map((slot) => `img_${slot}`),
      ];

      for (const [index, image] of item.images.entries()) {
        const slotIndex = Math.min(index, imageSlots.length - 1);
        const slotKey = imageSlots[slotIndex];
        const isPrimarySlot = slotIndex === 0;
        const replacement = await imageToReplacement(slotKey, image, {
          widthInches: isPrimarySlot ? 2.4 : 5.2,
          heightInches: isPrimarySlot ? 1.6 : 3.2,
        });

        if (replacement) {
          replacements.push(replacement);
        }
      }
    }
  }

  await addImageReplacements(
    "img_technician_signature",
    inspection.technicianSignature ? [inspection.technicianSignature] : [],
    { widthInches: 3.8, heightInches: 1.2 },
  );
  await addImageReplacements(
    "img_customer_signature",
    inspection.clientSignature || inspection.signature
      ? [inspection.clientSignature || inspection.signature!]
      : [],
    { widthInches: 3.8, heightInches: 1.2 },
  );
  if (
    inspection.signatureDataUrl &&
    !inspection.clientSignature &&
    !inspection.signature
  ) {
    replacements.push({
      dataUrl: inspection.signatureDataUrl,
      extension: getImageExtension(inspection.signatureDataUrl),
      heightInches: 1.2,
      key: "img_customer_signature",
      widthInches: 3.6,
    });
  }

  return replacements;
}

function signatureParagraph(
  text: string,
  before = 0,
  bold = false,
  pageBreak = false,
) {
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="120"/>${pageBreak ? "<w:pageBreakBefore/>" : ""}${bold ? "<w:keepNext/>" : ""}</w:pPr><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function signatureSectionXml(
  inspection: Inspection,
  images: Map<string, string[]>,
) {
  const signatureImage = (key: string) =>
    images.get(key)?.join("") || signatureParagraph("Assinatura pendente", 260);
  const technicianName =
    inspection.technicianSnapshot?.name ||
    getField(inspection, "164") ||
    "Não informado";
  const technicianCpf =
    inspection.technicianSnapshot?.identifier || "Não informado";
  const clientName = inspection.clientSnapshot?.name || "Não informado";
  const clientCnpj = inspection.clientSnapshot?.identifier || "Não informado";
  return [
    signatureParagraph("ASSINATURAS DA INSPEÇÃO", 0, true, true),
    signatureParagraph("Assinatura do técnico", 240, true),
    signatureImage("img_technician_signature"),
    signatureParagraph(`Nome: ${technicianName}`),
    signatureParagraph(`CPF: ${technicianCpf}`),
    signatureParagraph("Assinatura do cliente", 620, true),
    signatureImage("img_customer_signature"),
    signatureParagraph(`Cliente: ${clientName}`),
    signatureParagraph(`CNPJ: ${clientCnpj}`),
  ].join("");
}

async function loadTemplateZip() {
  return JSZip.loadAsync(
    await fs.readFile(path.resolve("template/inspecao-final-assinatura.docx")),
  );
}

export async function createInspectionDocxAsync(inspection: Inspection) {
  const zip = await loadTemplateZip();
  // Preserve the technical template. Replace the previous company's header/footer.
  for (const name of Object.keys(zip.files).filter((n) =>
    /^word\/(header|footer)\d+\.xml$/.test(n),
  )) {
    const header = name.includes("header"),
      tag = header ? "hdr" : "ftr";
    const content = header
      ? '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="8B671D"/><w:sz w:val="32"/></w:rPr><w:t>BR LIFT</w:t></w:r></w:p><w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>INSPEÇÃO E VISTORIA DE EQUIPAMENTO</w:t></w:r></w:p>'
      : '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="14"/></w:rPr><w:t>A - Em conformidade | B - Programar manutenção | C - Falha crítica | D - Não se aplica</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="14"/></w:rPr><w:t xml:space="preserve">BR LIFT - Página </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t xml:space="preserve"> de </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p>';
    zip.file(
      name,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:' +
        tag +
        ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        content +
        "</w:" +
        tag +
        ">",
    );
  }
  const documentFile = zip.file(DOCUMENT_XML_PATH);
  const headerFile = zip.file("word/header1.xml");
  if (headerFile && !inspection.finalizedAt)
    zip.file(
      "word/header1.xml",
      (await headerFile.async("string")).replace(
        "INSPEÇÃO E VISTORIA DE EQUIPAMENTO",
        "RASCUNHO - INSPEÇÃO NÃO FINALIZADA",
      ),
    );
  const relsFile = zip.file(DOCUMENT_RELS_PATH);

  if (!documentFile || !relsFile) {
    throw new Error("Template DOCX inválido.");
  }

  let documentXml = cleanInspectionTemplateXml(
    await documentFile.async("string"),
  );
  documentXml = documentXml.replace(/<w:document\b[^>]*>/, (root) => {
    for (const [prefix, uri] of Object.entries({
      a: "http://schemas.openxmlformats.org/drawingml/2006/main",
      pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
      wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    }))
      if (!root.includes("xmlns:" + prefix + "="))
        root = root.slice(0, -1) + " xmlns:" + prefix + '="' + uri + '">';
    return root;
  });
  let relsXml = await relsFile.async("string");
  const textValues = buildTextValues(inspection);
  const imageReplacements = await buildImageReplacements(inspection);
  let nextRelationshipId = getNextRelationshipId(relsXml);
  const imageParagraphsByKey = new Map<string, string[]>();

  documentXml = replaceTextPlaceholders(documentXml, textValues).replace(
    /STG/g,
    "BR LIFT",
  );

  for (const replacement of imageReplacements) {
    const fileName = `stg-${replacement.key}-${Date.now()}-${nextRelationshipId}.${replacement.extension}`;
    const relationshipId = `rId${nextRelationshipId}`;
    const mediaPath = `word/media/${fileName}`;

    zip.file(mediaPath, dataUrlToBase64(replacement.dataUrl), { base64: true });
    relsXml = appendImageRelationship(
      relsXml,
      relationshipId,
      `media/${fileName}`,
    );
    imageParagraphsByKey.set(replacement.key, [
      ...(imageParagraphsByKey.get(replacement.key) || []),
      createImageParagraph(
        relationshipId,
        replacement.widthInches,
        replacement.heightInches,
      ),
    ]);
    nextRelationshipId += 1;
  }

  for (const [key, paragraphs] of imageParagraphsByKey.entries()) {
    if (key === "img_customer_signature" || key === "img_technician_signature")
      continue;
    documentXml = replaceImageBlock(documentXml, key, paragraphs.join(""));
  }
  documentXml = replaceImageBlock(
    documentXml,
    "img_customer_signature",
    signatureSectionXml(inspection, imageParagraphsByKey),
  );

  documentXml = documentXml.replace(/\{\{([^}]+)\}\}/g, "");
  documentXml = removeTemplateImageParagraphs(documentXml);
  documentXml = documentXml.replace(
    /\{#(img_[^}]+)\}[\s\S]*?\{%image\}[\s\S]*?\{\/\1\}/g,
    "",
  );
  documentXml = documentXml.replace(/\{#(img_[^}]+)\}/g, "");
  documentXml = documentXml.replace(/\{%image\}/g, "");
  documentXml = documentXml.replace(/\{\/(img_[^}]+)\}/g, "");

  const remainingImageKeys = [
    ...new Set(
      [...documentXml.matchAll(/\{#(img_[^}]+)\}/g)].map((match) => match[1]),
    ),
  ];
  for (const key of remainingImageKeys) {
    documentXml = removeImageBlock(documentXml, key);
  }

  zip.file(DOCUMENT_XML_PATH, documentXml);
  zip.file(DOCUMENT_RELS_PATH, relsXml);

  const outputBuffer = await zip.generateAsync({
    compression: "DEFLATE",
    type: "nodebuffer",
  });

  return outputBuffer;
}
