export interface ObjectStorage {
  save(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Arquivo não encontrado: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageConflictError extends Error {
  constructor(key: string) {
    super(`Arquivo já existe: ${key}`);
    this.name = "StorageConflictError";
  }
}

export function assertStorageKey(key: string): string {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    !/^[A-Za-z0-9._/-]+$/.test(key) ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Chave de armazenamento inválida: ${key}`);
  return key;
}
