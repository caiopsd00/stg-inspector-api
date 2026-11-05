import { createHash } from "node:crypto";

import {
  StorageConflictError,
  StorageNotFoundError,
  type ObjectStorage,
} from "./types.js";

export type MigrationFile = {
  key: string;
  sha256: string;
  size: number;
  mime: string;
};
export type MigrationResult = {
  key: string;
  status: "copied" | "skipped" | "would-copy" | "missing" | "error";
  detail?: string;
};

function verified(bytes: Buffer, file: MigrationFile) {
  return (
    bytes.length === file.size &&
    createHash("sha256").update(bytes).digest("hex") === file.sha256
  );
}

export async function migrateFile(
  file: MigrationFile,
  sourceStorage: ObjectStorage,
  destinationStorage: ObjectStorage,
  dryRun: boolean,
): Promise<MigrationResult> {
  try {
    if (await destinationStorage.exists(file.key)) {
      const remote = await destinationStorage.read(file.key);
      if (!verified(remote, file))
        return { key: file.key, status: "error", detail: "Destino difere do banco (tamanho/hash)." };
      return { key: file.key, status: "skipped" };
    }
    let source: Buffer;
    try {
      source = await sourceStorage.read(file.key);
    } catch (error) {
      if (error instanceof StorageNotFoundError)
        return { key: file.key, status: "missing", detail: "Ausente na origem e no destino." };
      throw error;
    }
    if (!verified(source, file))
      return { key: file.key, status: "error", detail: "Origem difere do banco (tamanho/hash)." };
    if (dryRun) return { key: file.key, status: "would-copy" };
    let copied = true;
    try {
      await destinationStorage.save(file.key, source, file.mime);
    } catch (error) {
      if (!(error instanceof StorageConflictError)) throw error;
      copied = false;
    }
    const remote = await destinationStorage.read(file.key);
    if (!verified(remote, file))
      return { key: file.key, status: "error", detail: "Cópia concluída, mas verificação falhou." };
    return { key: file.key, status: copied ? "copied" : "skipped" };
  } catch (error) {
    return {
      key: file.key,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
