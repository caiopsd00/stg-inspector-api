import "dotenv/config";

import { parseStorageConfig, type StorageBackend } from "./config.js";
import { GoogleCloudStorage } from "./gcs.js";
import { LocalStorage } from "./local.js";
import { StorageNotFoundError, type ObjectStorage } from "./types.js";

export class RoutedStorage implements ObjectStorage {
  constructor(
    private readonly writeBackend: ObjectStorage,
    private readonly readBackends: ObjectStorage[],
  ) {}

  save(key: string, bytes: Buffer, contentType?: string) {
    return this.writeBackend.save(key, bytes, contentType);
  }

  async read(key: string): Promise<Buffer> {
    for (const backend of this.readBackends) {
      try {
        return await backend.read(key);
      } catch (error) {
        if (!(error instanceof StorageNotFoundError)) throw error;
      }
    }
    throw new StorageNotFoundError(key);
  }

  async exists(key: string): Promise<boolean> {
    for (const backend of this.readBackends)
      if (await backend.exists(key)) return true;
    return false;
  }

  async delete(key: string): Promise<void> {
    for (const backend of new Set(this.readBackends)) await backend.delete(key);
  }
}

let cached: { signature: string; storage: ObjectStorage } | undefined;

export function getObjectStorage(): ObjectStorage {
  const config = parseStorageConfig();
  const signature = JSON.stringify(config);
  if (cached?.signature === signature) return cached.storage;
  const backends: Partial<Record<StorageBackend, ObjectStorage>> = {
    local: new LocalStorage(config.localDir),
  };
  if (config.gcsBucket) backends.gcs = new GoogleCloudStorage(config.gcsBucket);
  const storage = new RoutedStorage(
    backends[config.write]!,
    config.reads.map((backend) => backends[backend]!),
  );
  cached = { signature, storage };
  return storage;
}

export async function assertStorageReady(): Promise<void> {
  const config = parseStorageConfig();
  getObjectStorage();
  if (config.reads.includes("local"))
    await new LocalStorage(config.localDir).assertReady();
  if (config.gcsBucket && config.write === "gcs")
    await new GoogleCloudStorage(config.gcsBucket).assertPrivateBucket();
}

export function mediaStorageKey(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("ID de mídia inválido.");
  return `media/${id}`;
}
