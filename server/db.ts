import "dotenv/config";
import pg from "pg";
// PostgreSQL DATE has no timezone; keep it as YYYY-MM-DD on every host.
pg.types.setTypeParser(1082, (value) => value);
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
pool.on("error", (error) => {
  console.error("Erro em conexão ociosa do PostgreSQL:", error.message);
});
export async function transaction<T>(
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
