import { Router } from "express";

import { usersController } from "../controllers/users.controller.js";

export function createUsersRoutes() {
  const routes = Router();
  routes.post("/users", usersController.create);
  routes.get("/profile", usersController.profile);
  routes.put("/profile", usersController.updateProfile);
  routes.get("/users", usersController.list);
  routes.put("/users/:id", usersController.update);
  routes.put("/users/:id/active", usersController.setActive);
  return routes;
}
