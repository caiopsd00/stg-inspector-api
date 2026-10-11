import crypto from "node:crypto";

import type { User } from "../auth.js";
import { sha, verifyPassword } from "../auth.js";
import { fail } from "../relational-utils.js";
import {
  activeUserByEmail,
  createSession,
  deleteSession,
} from "../repositories/auth-repository.js";
import { databaseIdentity } from "./database-identity.js";

export function createAuthService() {
  const attempts = new Map<string, { count: number; until: number }>();

  return {
    async login(email: string, password: string, ip: string) {
      const key = ip + ":" + email.toLowerCase();
      const attempt = attempts.get(key);
      if (attempt && attempt.until > Date.now() && attempt.count >= 10)
        throw fail(429, "Muitas tentativas. Aguarde 15 minutos.");
      if (attempts.size > 10000)
        for (const [attemptKey, value] of attempts)
          if (value.until < Date.now()) attempts.delete(attemptKey);
      const current =
        attempt && attempt.until > Date.now()
          ? attempt
          : { count: 0, until: Date.now() + 900000 };
      current.count++;
      attempts.set(key, current);
      const row = await activeUserByEmail(email);
      if (!row || !(await verifyPassword(password, row.password_hash)))
        throw fail(401, "E-mail ou senha inválidos.");
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString("hex");
      await createSession(sha(token), row.id);
      const user: User = {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
      };
      return { ...(await databaseIdentity()), token, user };
    },
    async logout(token: string) {
      await deleteSession(sha(token));
    },
  };
}
