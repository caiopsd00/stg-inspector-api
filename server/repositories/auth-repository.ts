import { pool } from "../db.js";

export async function activeUserByEmail(email: string) {
  const result = await pool.query(
    "SELECT * FROM users WHERE lower(email)=lower($1) AND active",
    [email],
  );
  return result.rows[0];
}

export async function createSession(tokenHash: string, userId: string) {
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    [tokenHash, userId],
  );
}

export async function deleteSession(tokenHash: string) {
  await pool.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash]);
}
