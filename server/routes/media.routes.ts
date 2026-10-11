import { Router } from "express";

import { mediaController } from "../controllers/media.controller.js";

export function createMediaRoutes() {
  const routes = Router();
  routes.post("/media", mediaController.upload);
  routes.get("/media/:id", mediaController.get);
  return routes;
}
