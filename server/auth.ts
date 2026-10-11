import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { pool } from "./db.js";
const scrypt = promisify(crypto.scrypt);
export const sha = (s: string | Buffer) =>
  crypto.createHash("sha256").update(s).digest("hex");
export async function hashPassword(value: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  return (
    salt + ":" + ((await scrypt(value, salt, 64)) as Buffer).toString("hex")
  );
}
export async function verifyPassword(value: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const got = (await scrypt(value, salt, 64)) as Buffer;
  return (
    expected.length === got.length && crypto.timingSafeEqual(expected, got)
  );
}
export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "technician";
};
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
export function sessionToken(req: Request) {
  return (
    req.headers.authorization?.replace(/^Bearer /, "") ||
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("brlift_session="))
      ?.split("=")[1] ||
    ""
  );
}
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const r = await pool.query(
      "SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active",
      [sha(sessionToken(req))],
    );
    if (!r.rows[0]) {
      res.status(401).json({ error: "Entre para continuar." });
      return;
    }
    req.user = r.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}
