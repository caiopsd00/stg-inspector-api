import type { Request, Response } from "express";

import { sha, sessionToken } from "../auth.js";
import {
  createUserAndTechnician,
  getProfile,
  listUsers,
  setUserActive,
  updateUserAndTechnician,
} from "../application/users-service.js";
import { fail } from "../relational-utils.js";
import { idSchema } from "../validation.js";

function requireAdmin(req: Request, action = "consultar") {
  if (req.user?.role !== "admin")
    throw fail(403, `Somente administradores podem ${action} usuários.`);
  return req.user;
}

export const usersController = {
  async create(req: Request, res: Response) {
    if (req.user?.role !== "admin")
      throw fail(403, "Somente administradores podem cadastrar usuários.");
    const result = await createUserAndTechnician(req.body, {
      actorUserId: req.user.id,
    });
    res.status(201).json(result);
  },
  async profile(req: Request, res: Response) {
    res.json({ user: await getProfile(req.user!.id) });
  },
  async updateProfile(req: Request, res: Response) {
    const result = await updateUserAndTechnician(req.user!.id, req.body, {
      actorUserId: req.user!.id,
      currentSessionHash: sha(sessionToken(req)),
      selfService: true,
    });
    res.json(result);
  },
  async list(req: Request, res: Response) {
    requireAdmin(req);
    res.json({ users: await listUsers() });
  },
  async update(req: Request, res: Response) {
    const user = requireAdmin(req, "editar");
    const result = await updateUserAndTechnician(
      idSchema.parse(req.params.id),
      req.body,
      {
        actorUserId: user.id,
        currentSessionHash: sha(sessionToken(req)),
      },
    );
    res.json(result);
  },
  async setActive(req: Request, res: Response) {
    if (req.user?.role !== "admin")
      throw fail(403, "Somente administradores podem alterar usuários.");
    if (typeof req.body?.active !== "boolean")
      throw fail(422, "Informe se o usuário deve ficar ativo.");
    res.json(
      await setUserActive(
        idSchema.parse(req.params.id),
        req.body.active,
        req.user.id,
      ),
    );
  },
};
