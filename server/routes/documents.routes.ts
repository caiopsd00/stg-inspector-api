import { Router } from "express";

import { createDocumentsController } from "../controllers/documents.controller.js";

export function createDocumentsRoutes() {
  const routes = Router();
  const controller = createDocumentsController();
  routes.get("/:kind/:id/document/:format", controller.download);
  return routes;
}
