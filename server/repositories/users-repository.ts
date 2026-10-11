import { pool } from "../db.js";

export async function profileByUserId(userId: string) {
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,t.cpf
     FROM users u LEFT JOIN technicians t ON t.user_id=u.id
     WHERE u.id=$1`,
    [userId],
  );
  return result.rows[0];
}

export async function userRows() {
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.active,t.id AS technician_id,t.cpf AS technician_cpf,t.active AS technician_active
     FROM users u LEFT JOIN technicians t ON t.user_id=u.id
     ORDER BY u.active DESC,u.name ASC`,
  );
  return result.rows;
}
