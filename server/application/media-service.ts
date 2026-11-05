import crypto from "node:crypto";

import type { User } from "../auth.js";
import { sha } from "../auth.js";
import { fail, type DB } from "../relational-utils.js";
import {
  insertMediaMetadata,
  mediaAccessRow,
  mediaByOwnerAndHash,
  type MediaAccessRow,
} from "../repositories/media-repository.js";
import { getObjectStorage, mediaStorageKey } from "../object-storage/index.js";
import { StorageNotFoundError } from "../object-storage/types.js";
import { prepareMediaImage } from "./media-image.js";
import { concurrencySetting, createConcurrencyLimit } from "../concurrency.js";

const runUpload = createConcurrencyLimit(
  concurrencySetting("MEDIA_UPLOAD_CONCURRENCY"),
  "Há outra imagem em processamento. Aguarde e tente novamente.",
);

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

export function uploadMedia(user: User, dataUrl: string, name: string) {
  return runUpload(() => storeMedia(user, dataUrl, name));
}

async function storeMedia(user: User, dataUrl: string, name: string) {
  const { bytes, mime, width, height } = await prepareMediaImage(dataUrl);
  const hash = sha(bytes);
  let old = await mediaByOwnerAndHash(user.id, hash);
  let id = old?.id;
  if (!id) {
    id = crypto.randomUUID();
    const key = mediaStorageKey(id);
    const storage = getObjectStorage();
    await storage.save(key, bytes, mime);
    let inserted = false;
    try {
      await insertMediaMetadata({
        id,
        hash,
        size: bytes.length,
        mime,
        userId: user.id,
        name,
        width,
        height,
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
      if (!inserted) await storage.delete(key);
    }
  }
  return {
    id,
    uri: "/api/media/" + id,
    name,
    width,
    height,
    createdAt: old?.created_at || new Date().toISOString(),
  };
}

export async function authorizedMedia(user: User, id: string) {
  const row = await mediaAccessRow(id, user.id);
  if (!row || !canAccessMedia(user, row))
    throw fail(404, "Arquivo não encontrado.");
  let bytes: Buffer;
  try {
    bytes = await getObjectStorage().read(row.storage_key);
  } catch (error) {
    if (error instanceof StorageNotFoundError)
      throw fail(404, "Arquivo não encontrado.");
    throw error;
  }
  return {
    mime: row.mime as string,
    bytes,
  };
}
