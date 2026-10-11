import type { Request, Response } from "express";

import { sessionToken } from "../auth.js";
import { createAuthService } from "../application/auth-service.js";
import { databaseIdentity } from "../application/database-identity.js";
import { loginInput } from "../validation.js";

export function createAuthController() {
  const auth = createAuthService();
  return {
    async login(req: Request, res: Response) {
      const { email, password } = loginInput.parse(req.body);
      const result = await auth.login(email, password, req.ip || "");
      res.cookie("brlift_session", result.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 7 * 86400000,
        path: "/",
      });
      res.json(result);
    },
    async me(req: Request, res: Response) {
      res.json({ user: req.user, ...(await databaseIdentity()) });
    },
    async logout(req: Request, res: Response) {
      await auth.logout(sessionToken(req));
      res.clearCookie("brlift_session", { path: "/" });
      res.json({ ok: true });
    },
  };
}
