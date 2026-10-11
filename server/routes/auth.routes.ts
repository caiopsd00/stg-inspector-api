import { Router } from "express";

import { createAuthController } from "../controllers/auth.controller.js";

export function createAuthRoutes() {
  const controller = createAuthController();
  const publicRoutes = Router();
  const privateRoutes = Router();
  publicRoutes.post("/login", controller.login);
  privateRoutes.get("/me", controller.me);
  privateRoutes.post("/logout", controller.logout);
  return { publicRoutes, privateRoutes };
}
