import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertStorageKey,
  StorageConflictError,
  StorageNotFoundError,
  type ObjectStorage,
} from "./types.js";

export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    return path.join(this.root, assertStorageKey(key));
  }

  async save(key: string, bytes: Buffer): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(file),
      `.upload-${randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Linking publishes the complete file atomically without overwriting it.
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new StorageConflictError(key);
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async assertReady(): Promise<void> {
    const key = `media/.ready-${randomUUID()}`;
    const bytes = Buffer.from("brlift-storage-check");
    try {
      await this.save(key, bytes);
      if (!(await this.read(key)).equals(bytes))
        throw Error("Falha na verificação do armazenamento local.");
    } finally {
      await this.delete(key);
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new StorageNotFoundError(key);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.file(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}
