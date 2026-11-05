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
import { createAttemptLimiter } from "../attempt-limiter.js";

export function createAuthService() {
  const addresses = createAttemptLimiter(60, 60000);
  const accounts = createAttemptLimiter(10, 900000);

  return {
    async login(email: string, password: string, ip: string) {
      const key = ip + ":" + email.toLowerCase();
      if (!addresses.allow(ip))
        throw fail(429, "Muitas tentativas de acesso. Aguarde um minuto.");
      if (!accounts.allow(key))
        throw fail(429, "Muitas tentativas. Aguarde 15 minutos.");
      const row = await activeUserByEmail(email);
      if (!row || !(await verifyPassword(password, row.password_hash)))
        throw fail(401, "E-mail ou senha inválidos.");
      accounts.reset(key);
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
