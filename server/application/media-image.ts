import sharp from "sharp";

import { fail } from "../relational-utils.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

// One vCPU is shared with PostgreSQL and LibreOffice in the pilot VPS.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

export async function prepareMediaImage(dataUrl: string) {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      dataUrl,
    );
  if (!match) throw fail(422, "Use PNG, JPEG ou WebP.");
  const source = Buffer.from(match[2], "base64");
  if (source.length > MAX_IMAGE_BYTES)
    throw fail(422, "Imagem maior que 10 MB.");

  let bytes: Buffer;
  let mime: "image/png" | "image/jpeg";
  try {
    const image = sharp(source, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "warning",
    });
    const original = await image.metadata();
    mime = original.hasAlpha ? "image/png" : "image/jpeg";
    const normalized = image.rotate().resize({
      width: 3200,
      height: 3200,
      fit: "inside",
      withoutEnlargement: true,
    });
    bytes =
      mime === "image/png"
        ? await normalized.png({ compressionLevel: 9 }).toBuffer()
        : await normalized.jpeg({ quality: 82 }).toBuffer();

    if (bytes.length > MAX_IMAGE_BYTES) {
      bytes = await sharp(source, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "warning",
      })
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 72 })
        .toBuffer();
      mime = "image/jpeg";
    }
  } catch {
    throw fail(422, "Imagem inválida ou excede 40 megapixels.");
  }
  if (bytes.length > MAX_IMAGE_BYTES)
    throw fail(422, "Imagem inválida ou maior que 10 MB.");
  const { width, height } = await sharp(bytes).metadata();
  return { bytes, mime, width, height };
}
