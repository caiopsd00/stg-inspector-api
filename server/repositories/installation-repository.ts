import { pool } from "../db.js";

export async function installationIdentity() {
  const result = await pool.query(
    "SELECT database_id,contract_version FROM app_instance WHERE singleton",
  );
  const row = result.rows[0];
  return { databaseId: row.database_id, contractVersion: row.contract_version };
}
