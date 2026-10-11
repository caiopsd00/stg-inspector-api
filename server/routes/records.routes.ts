import { Router } from "express";

import { recordsController } from "../controllers/records.controller.js";

export function createRecordsRoutes() {
  const routes = Router();
  routes.get("/:kind", recordsController.list);
  routes.get("/:kind/:id", recordsController.get);
  routes.put("/:kind/:id", recordsController.save);
  return routes;
}
