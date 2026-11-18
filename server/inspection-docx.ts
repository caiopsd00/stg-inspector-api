import fs from "node:fs/promises";
import { cleanInspectionTemplateXml } from "../contracts/inspection-template-cleanup.js";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { brandLogo, brandHeaderXml, brandHeaderNamespaces } from "./brand.js";
import { getObjectStorage, mediaStorageKey } from "./object-storage/index.js";
import type { ObjectStorage } from "./object-storage/types.js";
import {
  Inspection,
  InspectionImage,
  InspectionItem,
} from "../contracts/types.js";
import {
  normalizeInspectionResult,
  templateInspectionSections,
} from "../contracts/inspection-template.js";
import {
  dayPeriods,
  dayTotals,
  hasDayData,
  hasPeriodData,
  periodLabels,
  periodSummary,
  signatureDateTime,
} from "../contracts/domain.js";
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
  return escapeXml(
    (value?.trim() || "").replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,
      "",
    ),
  ).replace(/\r\n?|\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
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

async function imageBytes(uri: string, storage: ObjectStorage) {
  const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(uri);
  if (!match) throw Error("Referência de imagem inválida.");
  return storage.read(mediaStorageKey(match[1]));
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
        ? `\nObservação: ${item.observation.trim()}`
        : "";
      return `${item.code} - ${item.name} (${sectionName})${observation}`;
    })
    .join("\n\n");
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
  values.clientName = inspection.clientSnapshot?.name || "Não informado";
  const clientDocument = inspection.clientSnapshot?.identifier || "";
  values.clientDocument = /^[A-Z0-9]{12}[0-9]{2}$/i.test(clientDocument)
    ? clientDocument.replace(
        /^(.{2})(.{3})(.{3})(.{4})(.{2})$/,
        "$1.$2.$3/$4-$5",
      )
    : clientDocument || "Não informado";
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
  values["159"] =
    [
      getField(inspection, "equipmentPlate"),
      getField(inspection, "equipmentFleet"),
    ]
      .filter((value) => value && value !== "N/A")
      .join(" / ") || getField(inspection, "008");
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
  return xml.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const value = normalizeText(values[key]);
    return value && /^o_\d+$/.test(key)
      ? '</w:t><w:br/><w:t xml:space="preserve">Observação: ' + value
      : value;
  });
}

function identificationRow(
  row: string,
  from: string,
  to: string,
  label: string,
) {
  return row
    .replace(from, to)
    .replace(/\s+w14:(?:paraId|textId)="[^"]*"/g, "")
    .replace(/<w:trHeight\b[^>]*\/>/g, "")
    .replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/, (cell) => {
      let first = true;
      return cell.replace(/(<w:t\b[^>]*>)[\s\S]*?<\/w:t>/g, (_match, open) => {
        const text = first ? escapeXml(label) : "";
        first = false;
        return open + text + "</w:t>";
      });
    });
}

function alignChecklistTables(xml: string) {
  return xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) => {
    // Only checklist tables: keep identification, photographs and conclusions intact.
    if (!/\{\{o_\d+\}\}/.test(table)) return table;
    const grid = /<w:tblGrid\b[^>]*>[\s\S]*?<\/w:tblGrid>/.exec(table)?.[0];
    if (!grid) return table;
    const original = [
      ...grid.matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"[^>]*\/>/g),
    ].map((match) => Number(match[1]));
    if (original.length < 3) return table;
    // One shared number / description / situation grid, including measurement
    // subcolumns and merged cells from the original technical template.
    const middle = original.slice(1, -1);
    const middleTotal = middle.reduce((sum, width) => sum + width, 0);
    const widths = [
      810,
      ...middle.map((width) => Math.round((width * 7365) / middleTotal)),
      1290,
    ];
    widths[widths.length - 2] +=
      9465 - widths.reduce((sum, width) => sum + width, 0);
    table = table.replace(
      grid,
      `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
    );
    table = table.replace(
      /<w:tblPr\b[^>]*>([\s\S]*?)<\/w:tblPr>/,
      (_match, properties: string) =>
        `<w:tblPr>${properties.replace(/<w:(?:tblW|tblInd|tblLayout|jc)\b[^>]*\/>/g, "")}<w:tblW w:w="9465" w:type="dxa"/><w:jc w:val="left"/><w:tblInd w:w="0" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>`,
    );
    return table.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (row) => {
      let column = 0;
      return row.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell) => {
        const span = Number(
          /<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(cell)?.[1] || 1,
        );
        const width = widths
          .slice(column, column + span)
          .reduce((sum, value) => sum + value, 0);
        column += span;
        return cell.replace(
          /<w:tcW\b[^>]*\/>/,
          `<w:tcW w:w="${width}" w:type="dxa"/>`,
        );
      });
    });
  });
}

function prepareInspectionLayout(
  xml: string,
  inspection: Inspection,
  values: Record<string, string>,
) {
  // Reserve a real body area below the two-line header and above the footer.
  xml = xml.replace(/<w:pgMar\b[^>]*\/>/g, (margins) =>
    margins
      .replace(/w:top="\d+"/, 'w:top="1620"')
      .replace(/w:bottom="\d+"/, 'w:bottom="1440"'),
  );
  // Keep separate tables, but replace inherited runs of blank body paragraphs
  // with a single controlled spacer. Never remove text or explicit page breaks.
  xml = xml.replace(
    /<\/w:tbl>((?:\s*<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)+)\s*(?=<w:tbl\b)/g,
    (match, separator: string) =>
      /<w:(?:t|drawing|br|sectPr|pageBreakBefore|fldChar|fldSimple)\b/.test(
        separator,
      )
        ? match
        : '</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>',
  );
  xml = xml.replace(/<w:tcPr\b[^>]*>[\s\S]*?<\/w:tcPr>/g, (properties) => {
    const padding =
      '<w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/>';
    return properties.includes("<w:tcMar>")
      ? properties.replace(
          /<w:tcMar>([\s\S]*?)<\/w:tcMar>/,
          (_match, margins: string) =>
            `<w:tcMar>${margins.replace(/<w:(?:top|bottom)\b[^>]*\/>/g, "")}${padding}</w:tcMar>`,
        )
      : properties.replace(
          "</w:tcPr>",
          `<w:tcMar>${padding}</w:tcMar></w:tcPr>`,
        );
  });
  // Photos and observations must be allowed to expand a row, never be cropped
  // by an exact height inherited from the old Word document.
  xml = xml.replace(/<w:trHeight\b[^>]*\/>/g, (height) =>
    height.replace('w:hRule="exact"', 'w:hRule="atLeast"'),
  );
  // These three fields now appear together immediately above the signatures.
  xml = xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (table) =>
    table.includes("{{164}}") ? "" : table,
  );
  xml = alignChecklistTables(xml);
  const textOf = (fragment: string) =>
    [...fragment.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join("");
  xml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const value = textOf(paragraph).trim();
    if (/^GUINDASTE\s+[–-]\s+\{\{001\}\}$/.test(value)) return "";
    return paragraph;
  });
  xml = xml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (row) => {
    if (row.includes("{{161}}")) {
      // The old opinion cell used blank paragraphs as padding. They could spill
      // onto the next page after all visible text, creating a misleading gap.
      return row
        .replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
          const text = textOf(paragraph).replace(
            /\{\{([^}]+)\}\}/g,
            (_match, key: string) => values[key] || "",
          );
          return text.trim() ? paragraph : "";
        })
        .replace("<w:trPr>", "<w:trPr><w:cantSplit/>");
    }
    if (row.includes("{{011}}") || row.includes("{{165}}")) return "";
    if (row.includes("{{002}}"))
      return [
        identificationRow(row, "{{002}}", "{{clientName}}", "CLIENTE"),
        identificationRow(row, "{{002}}", "{{clientDocument}}", "CNPJ"),
        identificationRow(row, "{{002}}", "{{equipmentBrand}}", "MARCA"),
        row,
      ].join("");
    if (row.includes("{{008}}")) {
      if (
        "equipmentPlate" in inspection.documentFields ||
        "equipmentFleet" in inspection.documentFields
      )
        return (
          identificationRow(row, "{{008}}", "{{equipmentPlate}}", "PLACA") +
          identificationRow(row, "{{008}}", "{{equipmentFleet}}", "FROTA")
        );
      return row;
    }
    if (row.includes("{{007}}"))
      return row.replace("QUILOMETRAGEM*", "QUILOMETRAGEM");
    if (row.includes("{{006}}")) {
      const lower = row.replace("HORÍMETRO", "HORÍMETRO INFERIOR");
      const upper = row
        .replace("HORÍMETRO", "HORÍMETRO SUPERIOR")
        .replace("{{006}}", "{{hourmeterUpper}}")
        .replace(/\s+w14:(?:paraId|textId)="[^"]*"/g, "");
      return lower + upper;
    }
    return row;
  });
  const checklist = xml.indexOf("{{o_015}}");
  const table = checklist < 0 ? -1 : xml.lastIndexOf("<w:tbl>", checklist);
  if (table >= 0)
    xml = xml.slice(0, table) + "<!--brlift-schedule-->" + xml.slice(table);
  return xml;
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

  return `<w:p><w:pPr><w:keepLines/><w:spacing w:before="160" w:after="160" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="Imagem STG"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Imagem STG"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function keepImageRowsTogether(xml: string) {
  return xml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (row) => {
    const image = row.includes("<w:drawing>");
    const heading =
      /<w:shd\b[^>]*w:fill="(?:808080|D9D9D9)"/.test(row) ||
      /FOTOGRAFIA DO EQUIPAMENTO|DADOS TÉCNICOS DO EQUIPAMENTO|INSPEÇÃO CABO DE AÇO/.test(
        row,
      );
    if (!image && !heading) return row;
    row = row.replace(/<w:cantSplit\b[^>]*\/>/g, "");
    row = row.includes("<w:trPr>")
      ? row.replace("<w:trPr>", "<w:trPr><w:cantSplit/>")
      : row.replace(/(<w:tr\b[^>]*>)/, "$1<w:trPr><w:cantSplit/></w:trPr>");
    if (!heading) return row;
    // A section/photo label must travel with its first content row. Oversized
    // photo rows can still span pages, but individual inline photos stay intact.
    return row.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
      const keep = "<w:keepNext/>";
      return paragraph.includes("<w:pPr>")
        ? paragraph.replace(
            /<w:pPr>([\s\S]*?)<\/w:pPr>/,
            (_match, properties: string) =>
              `<w:pPr>${keep}${properties.replace(/<w:keepNext\b[^>]*\/>/g, "")}</w:pPr>`,
          )
        : paragraph.replace(/(<w:p\b[^>]*>)/, `$1<w:pPr>${keep}</w:pPr>`);
    });
  });
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
  storage: ObjectStorage,
) {
  if (!image) {
    return undefined;
  }

  const bytes = await imageBytes(image.uri, storage);
  const size = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
  const dataUrl =
    "data:image/" +
    (bytes[0] === 255 ? "jpeg" : "png") +
    ";base64," +
    bytes.toString("base64");
  const dimensions = fitImageWithinBounds(
    { width: size.width!, height: size.height! },
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

async function buildImageReplacements(
  inspection: Inspection,
  storage: ObjectStorage,
) {
  const replacements: ImageReplacement[] = [];
  const addImageReplacements = async (
    key: string,
    images: InspectionImage[] | undefined,
    bounds: ImageBounds,
  ) => {
    for (const image of images || []) {
      const replacement = await imageToReplacement(key, image, bounds, storage);

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
      const complementarySlots =
        templateInspectionSections
          .flatMap((section) => section.items)
          .find((candidate) => candidate.code === item.code)?.extraImageSlots ||
        item.extraImageSlots ||
        [];
      const imageSlots = [
        `img_${item.code}`,
        ...complementarySlots.map((slot) => `img_${slot}`),
      ];

      for (const [index, image] of item.images.entries()) {
        const slotIndex = Math.min(index, imageSlots.length - 1);
        const slotKey = imageSlots[slotIndex];
        const isPrimarySlot = slotIndex === 0;
        const replacement = await imageToReplacement(
          slotKey,
          image,
          {
            widthInches: isPrimarySlot ? 2.4 : 5.2,
            heightInches: isPrimarySlot ? 1.6 : 3.2,
          },
          storage,
        );

        if (replacement) {
          replacements.push(replacement);
        }
      }
      for (const slot of complementarySlots)
        await addImageReplacements(
          `img_${slot}`,
          inspection.documentImages[slot],
          {
            widthInches: 5.2,
            heightInches: 3.2,
          },
        );
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

function documentParagraph(
  text: string,
  { before = 0, bold = false, pageBreak = false, center = false } = {},
) {
  return `<w:p><w:pPr>${bold ? "<w:keepNext/>" : ""}${pageBreak ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="${before}" w:after="120"/>${center ? '<w:jc w:val="center"/>' : ""}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>${bold ? "<w:b/>" : ""}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${normalizeText(text)}</w:t></w:r></w:p>`;
}

function scheduleSectionXml(inspection: Inspection) {
  const days = (inspection.days || []).filter(hasDayData);
  const vehicle = inspection.vehicleSnapshot;
  const total = days.reduce(
    (sum, day) => {
      const current = dayTotals(day);
      return {
        work: sum.work + current.work,
        travel: sum.travel + current.travel,
        km: sum.km + current.km,
      };
    },
    { work: 0, travel: 0, km: 0 },
  );
  return [
    ...(vehicle
      ? [
          documentParagraph(
            "Veículo: " +
              [
                vehicle.plate,
                vehicle.model,
                vehicle.color,
                vehicle.rentalCompany,
              ]
                .filter(Boolean)
                .join(" · "),
          ),
        ]
      : []),
    ...(days.length
      ? [
          documentParagraph("CRONOGRAMA DE INSPEÇÃO", {
            before: 160,
            bold: true,
          }),
        ]
      : []),
    ...days.flatMap((day, index) => {
      const totals = dayTotals(day);
      const date = new Date(`${day.date}T12:00:00`);
      const label = Number.isNaN(date.getTime())
        ? day.date
        : date.toLocaleDateString("pt-BR", {
            weekday: "long",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          });
      return [
        documentParagraph(`Dia ${index + 1} — ${label}`, {
          before: 120,
          bold: true,
        }),
        ...(day.notes
          ? [documentParagraph(`Observações do dia: ${day.notes}`)]
          : []),
        ...(["outbound", "work", "inbound"] as const).flatMap((kind) =>
          dayPeriods(day)
            .filter((period) => period.kind === kind && hasPeriodData(period))
            .map((period, i) =>
              documentParagraph(
                `${periodLabels[kind]} ${i + 1}: ${period.start || "—"} às ${period.end || "—"}` +
                  ` · Pausa: ${period.pauseMinutes || "0"} min · Total do item: ${periodSummary(period)}` +
                  ` · Quilometragem inicial: ${period.odometerStart || "—"} · Quilometragem final: ${period.odometerEnd || "—"}`,
              ),
            ),
        ),
        documentParagraph(
          `Resumo do dia: Trabalho líquido ${totals.work} min · Deslocamento líquido ${totals.travel} min · Quilometragem total ${totals.km}`,
          { bold: true },
        ),
      ];
    }),
    ...(days.length
      ? [
          documentParagraph("RESUMO DO CRONOGRAMA", {
            before: 240,
            bold: true,
          }),
          documentParagraph(
            `Trabalho líquido: ${total.work} min · Deslocamento líquido: ${total.travel} min · Quilometragem total: ${total.km}. Pausas já descontadas.`,
          ),
        ]
      : []),
  ].join("");
}

function signatureSectionXml(
  inspection: Inspection,
  images: Map<string, string[]>,
  values: Record<string, string>,
) {
  const signatureImage = (key: string) =>
    images.get(key)?.join("") ||
    documentParagraph("Assinatura pendente", { before: 260, center: true });
  const caption = (
    image: InspectionImage | undefined,
    name: string | undefined,
    role: string,
  ) =>
    image
      ? documentParagraph(
          [
            image.signerName || name || "Nome não registrado",
            role,
            signatureDateTime(image.createdAt),
          ]
            .filter(Boolean)
            .join("\n"),
          { center: true },
        )
      : "";
  const signatureBlock = (
    title: string,
    key: string,
    identity: string,
    before: number,
  ) => {
    const parts = [
      documentParagraph(title, { before, bold: true, center: true }),
      signatureImage(key),
      identity,
    ].filter(Boolean);
    // Each signature is an independent unit: title, drawing, name and date
    // travel together, without forcing the entire closing section to a new page.
    return parts
      .map((part, index) =>
        part.replace(
          /<w:pPr>([\s\S]*?)<\/w:pPr>/g,
          (_match, properties: string) =>
            `<w:pPr><w:keepLines/>${index < parts.length - 1 ? "<w:keepNext/>" : ""}${properties.replace(/<w:(?:keepNext|keepLines)\b[^>]*\/>/g, "")}</w:pPr>`,
        ),
      )
      .join("");
  };
  return [
    documentParagraph("RESULTADO E ASSINATURAS DA INSPEÇÃO", {
      bold: true,
      before: 240,
    }),
    inspectionResultTableXml(values),
    signatureBlock(
      "Assinatura do técnico",
      "img_technician_signature",
      caption(inspection.technicianSignature, values["164"], "Técnico"),
      240,
    ),
    signatureBlock(
      "Assinatura do cliente",
      "img_customer_signature",
      caption(
        inspection.clientSignature || inspection.signature,
        inspection.clientSnapshot?.name,
        "Representante do cliente",
      ),
      620,
    ),
  ].join("");
}

function inspectionResultTableXml(values: Record<string, string>) {
  const rows = [
    ["Resultado da vistoria:", values["011"] || "Não informado"],
    ["Inspeção realizada por:", values["164"] || "Não informado"],
    ["Inspeção aprovada por:", values["165"] || "Não informado"],
  ];
  return `<w:tbl><w:tblPr><w:tblW w:w="9330" w:type="dxa"/><w:jc w:val="left"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="6" w:color="000000"/>`).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4665"/><w:gridCol w:w="4665"/></w:tblGrid>${rows.map((row, index) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="600" w:hRule="atLeast"/></w:trPr>${row.map((text) => `<w:tc><w:tcPr><w:tcW w:w="4665" w:type="dxa"/><w:tcMar><w:top w:w="120" w:type="dxa"/><w:left w:w="150" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="150" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>${index < rows.length - 1 ? "<w:keepNext/>" : ""}<w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${normalizeText(text)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

async function loadTemplateZip() {
  return JSZip.loadAsync(
    await fs.readFile(path.resolve("template/inspecao-final-assinatura.docx")),
  );
}

export async function createInspectionDocxAsync(
  inspection: Inspection,
  storage: ObjectStorage = getObjectStorage(),
) {
  const zip = await loadTemplateZip();
  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  if (!/Extension="png"/i.test(contentTypes))
    zip.file(
      "[Content_Types].xml",
      contentTypes.replace(
        "</Types>",
        '<Default Extension="png" ContentType="image/png"/></Types>',
      ),
    );
  zip.file("word/media/brlift-brand.png", await brandLogo("ink"));
  // Preserve the technical template. Replace the previous company's header/footer.
  for (const name of Object.keys(zip.files).filter((n) =>
    /^word\/(header|footer)\d+\.xml$/.test(n),
  )) {
    const header = name.includes("header"),
      tag = header ? "hdr" : "ftr";
    const content = header
      ? brandHeaderXml("INSPEÇÃO E VISTORIA DE EQUIPAMENTO")
      : '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="14"/></w:rPr><w:t>A - Em conformidade | B - Programar manutenção | C - Falha crítica | D - Não se aplica</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="14"/></w:rPr><w:t xml:space="preserve">BR LIFT - Página </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t xml:space="preserve"> de </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p>';
    zip.file(
      name,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:' +
        tag +
        " " +
        brandHeaderNamespaces +
        ">" +
        content +
        "</w:" +
        tag +
        ">",
    );
    if (header) {
      const filename = name.split("/").pop();
      zip.file(
        `word/_rels/${filename}.rels`,
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdBRLiftBrand" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/brlift-brand.png"/></Relationships>',
      );
    }
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
  const imageReplacements = await buildImageReplacements(inspection, storage);
  let nextRelationshipId = getNextRelationshipId(relsXml);
  const imageParagraphsByKey = new Map<string, string[]>();

  documentXml = prepareInspectionLayout(
    documentXml.replace(/STG/g, "BR LIFT"),
    inspection,
    textValues,
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
    "<!--brlift-signatures-->",
  );
  // Remove spacers left by the old signer table so the closing section follows
  // the opinion naturally, without an artificial gap or an empty page.
  documentXml = documentXml.replace(
    /<\/w:tbl>((?:\s*<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)+)\s*<!--brlift-signatures-->/g,
    (match, separator: string) =>
      /<w:(?:t|drawing|br|sectPr|fldChar|fldSimple)\b/.test(separator)
        ? match
        : "</w:tbl><!--brlift-signatures-->",
  );

  documentXml = removeTemplateImageParagraphs(documentXml);
  documentXml = keepImageRowsTogether(documentXml);
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

  documentXml = replaceTextPlaceholders(documentXml, textValues)
    .replace("<!--brlift-schedule-->", () => scheduleSectionXml(inspection))
    .replace("<!--brlift-signatures-->", () =>
      signatureSectionXml(inspection, imageParagraphsByKey, textValues),
    );

  zip.file(DOCUMENT_XML_PATH, documentXml);
  zip.file(DOCUMENT_RELS_PATH, relsXml);

  const outputBuffer = await zip.generateAsync({
    compression: "DEFLATE",
    type: "nodebuffer",
  });

  return outputBuffer;
}
