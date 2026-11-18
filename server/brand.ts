import fs from "node:fs/promises";
import path from "node:path";

export const brandColors = { ink: "#2a2a2e", lime: "#cae211" } as const;
export const brandAspectRatio = 199 / 157;

/** Local, versioned brand assets: document generation never fetches a logo online. */
export function brandLogo(variant: "ink" | "lime") {
  return fs.readFile(path.resolve(`branding/brlift-${variant}.png`));
}

export function brandHeaderXml(caption: string) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="14" w:space="8" w:color="CAE211"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="8800"/></w:tabs></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="710000" cy="560151"/><wp:docPr id="901000" name="BR LIFT" descr="BR LIFT — Serviços técnicos"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="BR LIFT"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdBRLiftBrand"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="710000" cy="560151"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:rPr><w:color w:val="2A2A2E"/><w:sz w:val="16"/></w:rPr><w:tab/><w:t>${caption}</w:t></w:r></w:p>`;
}

export const brandHeaderNamespaces =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
