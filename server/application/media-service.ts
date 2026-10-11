import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import type { User } from "../auth.js";
import { sha } from "../auth.js";
import { fail, type DB } from "../relational-utils.js";
import {
  insertMediaMetadata,
  mediaAccessRow,
  mediaByOwnerAndHash,
  type MediaAccessRow,
} from "../repositories/media-repository.js";
import { storageDir } from "../storage.js";

function canAccessMedia(user: User, row: MediaAccessRow | undefined): boolean {
  return Boolean(
    row &&
    (user.role === "admin" ||
      row.created_by === user.id ||
      row.in_own_report ||
      row.in_own_inspection),
  );
}

export async function validateMediaReferences(
  db: DB,
  payload: unknown,
  user: User,
) {
  const uris = new Set<string>();
  function walk(value: unknown) {
    if (typeof value === "string" && /^(file:|data:|blob:)/.test(value))
      throw fail(422, "Publique as imagens antes de salvar o registro.");
    if (!value || typeof value !== "object") return;
    if ("uri" in value && typeof value.uri === "string") uris.add(value.uri);
    for (const child of Object.values(value)) walk(child);
  }
  walk(payload);
  for (const uri of uris) {
    const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(uri);
    if (
      !match ||
      !canAccessMedia(user, await mediaAccessRow(match[1], user.id, db))
    )
      throw fail(422, "Imagem não disponível para este usuário.");
  }
}

export async function uploadMedia(user: User, dataUrl: string, name: string) {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      dataUrl,
    );
  if (!match) throw fail(422, "Use PNG, JPEG ou WebP.");
  const source = Buffer.from(match[2], "base64");
  if (source.length > 10 * 1024 * 1024)
    throw fail(422, "Imagem maior que 10 MB.");
  let bytes: Buffer;
  try {
    bytes = await sharp(source, {
      limitInputPixels: 40000000,
      failOn: "warning",
    })
      .rotate()
      .png()
      .toBuffer();
  } catch {
    throw fail(422, "Imagem inválida ou excede 40 megapixels.");
  }
  const valid = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!valid || bytes.length > 10 * 1024 * 1024)
    throw fail(422, "Imagem inválida ou maior que 10 MB.");
  const hash = sha(bytes);
  const dimensions = await sharp(bytes).metadata();
  let old = await mediaByOwnerAndHash(user.id, hash);
  let id = old?.id;
  if (!id) {
    id = crypto.randomUUID();
    const mediaDir = path.join(storageDir, "media");
    const filePath = path.join(mediaDir, id);
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(filePath, bytes, {
      flag: "wx",
    });
    let inserted = false;
    try {
      await insertMediaMetadata({
        id,
        hash,
        size: bytes.length,
        userId: user.id,
        name,
        width: dimensions.width,
        height: dimensions.height,
      });
      inserted = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "23505"
      ))
        throw error;
      old = await mediaByOwnerAndHash(user.id, hash);
      if (!old) throw error;
      id = old.id;
    } finally {
      if (!inserted) await fs.rm(filePath, { force: true });
    }
  }
  return {
    id,
    uri: "/api/media/" + id,
    name,
    width: dimensions.width,
    height: dimensions.height,
    createdAt: old?.created_at || new Date().toISOString(),
  };
}

export async function authorizedMedia(user: User, id: string) {
  const row = await mediaAccessRow(id, user.id);
  if (!row || !canAccessMedia(user, row))
    throw fail(404, "Arquivo não encontrado.");
  return {
    mime: row.mime as string,
    filePath: path.join(storageDir, "media", id),
  };
}
