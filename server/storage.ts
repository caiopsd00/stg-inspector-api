import path from "node:path";

export const storageDir = path.resolve(process.env.STORAGE_DIR || "storage");
