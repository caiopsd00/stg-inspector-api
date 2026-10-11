import type { Request, Response } from "express";

import {
  archiveCatalogItem,
  findPartByCode,
  listCatalogItems,
  saveCatalogItem,
} from "../application/catalog-service.js";
import { fail } from "../relational-utils.js";
import {
  archiveCatalogInput,
  catalogInput,
  catalogKinds,
  idSchema,
} from "../validation.js";

export const catalogController = {
  async list(req: Request, res: Response) {
    const kind = catalogKinds.parse(req.params.kind);
    res.json({ items: await listCatalogItems(kind) });
  },
  async partByCode(req: Request, res: Response) {
    const item = await findPartByCode(String(req.params.code));
    if (!item) throw fail(404, "Peça não cadastrada.");
    res.json({ item });
  },
  async save(req: Request, res: Response) {
    const kind = catalogKinds.parse(req.params.kind);
    const id = idSchema.parse(req.params.id);
    const input = catalogInput.parse({ ...req.body, id });
    res.json({ item: await saveCatalogItem(kind, id, input, req.user!.id) });
  },
  async archive(req: Request, res: Response) {
    const kind = catalogKinds.parse(req.params.kind);
    const id = idSchema.parse(req.params.id);
    const input = archiveCatalogInput.parse(req.body);
    res.json(await archiveCatalogItem(kind, id, input, req.user!.id));
  },
};
