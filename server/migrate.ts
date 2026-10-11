import fs from "node:fs/promises";
import path from "node:path";
import { pool, transaction } from "./db.js";
export async function migrate() {
  await transaction(async (db) => {
    if (
      (
        await db.query(
          "SELECT COALESCE(to_regclass('public.catalog'),to_regclass('public.records')) AS legacy",
        )
      ).rows[0].legacy
    )
      throw Error(
        "Banco legado detectado. Faça backup e use o procedimento explícito de reset; migrations não apagam dados.",
      );
    await db.query("SELECT pg_advisory_xact_lock(917426)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await fs.readdir("database"))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      if (
        (
          await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await db.query(await fs.readFile(path.join("database", name), "utf8"));
      await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}
if (
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js")
)
  migrate()
    .then(() => console.log("Migrations BR LIFT aplicadas."))
    .finally(() => pool.end());
