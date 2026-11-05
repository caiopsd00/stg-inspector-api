import path from "node:path";

export type StorageBackend = "local" | "gcs";
export type StorageConfig = {
  write: StorageBackend;
  reads: StorageBackend[];
  localDir: string;
  gcsBucket?: string;
};

export function parseStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const write = env.STORAGE_WRITE_BACKEND ?? "local";
  const read = env.STORAGE_READ_BACKENDS ?? "local";
  if (
    !(
      (write === "local" && read === "local") ||
      (write === "gcs" && (read === "gcs" || read === "gcs,local"))
    )
  )
    throw new Error(
      "STORAGE_WRITE_BACKEND/STORAGE_READ_BACKENDS inválidos. Use local/local, gcs/gcs,local ou gcs/gcs.",
    );
  const gcsBucket = env.GCS_BUCKET;
  if (
    write === "gcs" &&
    (!gcsBucket || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(gcsBucket))
  )
    throw new Error("GCS_BUCKET deve conter o nome de um bucket válido.");
  return {
    write,
    reads: read.split(",") as StorageBackend[],
    localDir: path.resolve(env.STORAGE_DIR || "storage"),
    gcsBucket,
  };
}
