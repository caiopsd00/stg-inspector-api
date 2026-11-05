import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import { prepareMediaImage } from "../server/application/media-image.js";

test("fotos JPEG não crescem além do limite ao serem normalizadas", async () => {
  const width = 2600;
  const height = 1700;
  const photo = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 65 })
    .toBuffer();
  assert.ok(photo.length < 10 * 1024 * 1024);
  assert.ok((await sharp(photo).png().toBuffer()).length > 10 * 1024 * 1024);

  const result = await prepareMediaImage(
    `data:image/jpeg;base64,${photo.toString("base64")}`,
  );
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.bytes.length < 10 * 1024 * 1024);
  assert.equal(result.width, width);
  assert.equal(result.height, height);
});

test("imagens com transparência preservam PNG", async () => {
  const transparent = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const result = await prepareMediaImage(
    `data:image/png;base64,${transparent.toString("base64")}`,
  );
  assert.equal(result.mime, "image/png");
  assert.equal(result.width, 8);
  assert.equal(result.height, 8);
});
