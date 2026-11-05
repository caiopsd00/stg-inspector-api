import "dotenv/config";

import { pool } from "./db.js";
import { parseStorageConfig } from "./object-storage/config.js";
import { GoogleCloudStorage } from "./object-storage/gcs.js";
import { LocalStorage } from "./object-storage/local.js";
import { migrateFile, type MigrationFile } from "./object-storage/migrate.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--dry-run", "--reverse"].includes(arg)))
    throw Error("Uso: npm run storage:migrate -- [--dry-run] [--reverse]");
  const dryRun = args.includes("--dry-run");
  const reverse = args.includes("--reverse");
  const config = parseStorageConfig();
  if (!config.gcsBucket) throw Error("Defina GCS_BUCKET para a migração.");
  const local = new LocalStorage(config.localDir);
  const gcs = new GoogleCloudStorage(config.gcsBucket);
  await gcs.assertPrivateBucket();
  const counts = { copied: 0, skipped: 0, "would-copy": 0, missing: 0, error: 0 };
  let lastId = "00000000-0000-0000-0000-000000000000";
  try {
    while (true) {
      const result = await pool.query<MigrationFile & { id: string }>(
        `SELECT id, storage_key AS key, sha256, size::integer AS size, mime
         FROM files WHERE id > $1 ORDER BY id LIMIT 200`,
        [lastId],
      );
      if (!result.rows.length) break;
      for (const file of result.rows) {
        const outcome = await migrateFile(
          file,
          reverse ? gcs : local,
          reverse ? local : gcs,
          dryRun,
        );
        counts[outcome.status]++;
        console.log(JSON.stringify(outcome));
        lastId = file.id;
      }
    }
    console.log(JSON.stringify({ summary: counts, dryRun, direction: reverse ? "gcs-to-local" : "local-to-gcs" }));
    if (counts.error || counts.missing) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  pool.end().catch(console.error);
});
