import { Storage, type Bucket } from "@google-cloud/storage";

import {
  assertStorageKey,
  StorageConflictError,
  StorageNotFoundError,
  type ObjectStorage,
} from "./types.js";

function status(error: unknown) {
  return Number((error as { code?: number | string })?.code);
}

export class GoogleCloudStorage implements ObjectStorage {
  private readonly bucket: Bucket;

  constructor(bucketName: string, client: Storage = new Storage()) {
    this.bucket = client.bucket(bucketName);
  }

  private file(key: string) {
    return this.bucket.file(assertStorageKey(key));
  }

  async assertPrivateBucket(): Promise<void> {
    const [metadata] = await this.bucket.getMetadata();
    if (
      metadata.iamConfiguration?.publicAccessPrevention !== "enforced" ||
      metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
    )
      throw new Error(
        "O bucket GCS deve ter Public Access Prevention enforced e Uniform Bucket-Level Access habilitado.",
      );
  }

  async save(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    try {
      await this.file(key).save(bytes, {
        contentType: contentType || "application/octet-stream",
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      if (status(error) === 412) throw new StorageConflictError(key);
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      const [bytes] = await this.file(key).download({ validation: "crc32c" });
      return bytes;
    } catch (error) {
      if (status(error) === 404) throw new StorageNotFoundError(key);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.file(key).exists();
    return exists;
  }

  async delete(key: string): Promise<void> {
    await this.file(key).delete({ ignoreNotFound: true });
  }
}
