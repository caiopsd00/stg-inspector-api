import { pool } from "../db.js";
import type { DB } from "../relational-utils.js";

export type MediaAccessRow = {
  mime: string;
  created_by: string;
  in_own_report: boolean;
  in_own_inspection: boolean;
};

export async function mediaByOwnerAndHash(userId: string, hash: string) {
  const result = await pool.query(
    "SELECT * FROM files WHERE created_by=$1 AND sha256=$2",
    [userId, hash],
  );
  return result.rows[0];
}

export async function insertMediaMetadata(input: {
  id: string;
  hash: string;
  size: number;
  userId: string;
  name: string;
  width?: number;
  height?: number;
}) {
  await pool.query(
    "INSERT INTO files(id,mime,sha256,size,created_by,name,storage_key,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      input.id,
      "image/png",
      input.hash,
      input.size,
      input.userId,
      input.name,
      "media/" + input.id,
      input.width,
      input.height,
    ],
  );
}

export async function mediaAccessRow(
  id: string,
  userId: string,
  db: DB = pool,
) {
  const result = await db.query(
    `SELECT f.mime,f.created_by,
       EXISTS (
         SELECT 1 FROM service_order_files sf
         JOIN service_order_team tm ON tm.service_order_id=sf.service_order_id
         JOIN technicians t ON t.id=tm.technician_id AND t.active
         WHERE sf.file_id=f.id AND t.user_id=$2
       ) AS in_own_report,
       EXISTS (
         SELECT 1 FROM inspection_files inf
         JOIN inspections i ON i.id=inf.inspection_id
         JOIN technicians t ON t.id=i.technician_id AND t.active
         WHERE inf.file_id=f.id AND t.user_id=$2
       ) AS in_own_inspection
     FROM files f WHERE f.id=$1`,
    [id, userId],
  );
  return result.rows[0] as MediaAccessRow | undefined;
}
