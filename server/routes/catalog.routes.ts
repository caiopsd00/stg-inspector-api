import { Router } from "express";

import { catalogController } from "../controllers/catalog.controller.js";

export function createCatalogRoutes() {
  const routes = Router();
  routes.get("/catalog/:kind", catalogController.list);
  routes.get("/parts/by-code/:code", catalogController.partByCode);
  routes.put("/catalog/:kind/:id", catalogController.save);
  routes.delete("/catalog/:kind/:id", catalogController.archive);
  return routes;
}
