import type { Request, Response } from "express";

import { listRecords, saveEntry } from "../application/record-service.js";
import { fail } from "../relational-utils.js";
import {
  idSchema,
  inspectionSchema,
  kinds,
  recordFilter,
  recordInput,
  reportSchema,
} from "../validation.js";

export const recordsController = {
  async list(req: Request, res: Response) {
    const kind = kinds.parse(req.params.kind);
    const filter = recordFilter.parse(req.query);
    res.json({ items: await listRecords(kind, req.user!, filter) });
  },
  async get(req: Request, res: Response) {
    const kind = kinds.parse(req.params.kind);
    const id = idSchema.parse(req.params.id);
    const item = (await listRecords(kind, req.user!, { id }))[0];
    if (!item) throw fail(404, "Registro não encontrado.");
    res.json({ item });
  },
  async save(req: Request, res: Response) {
    const kind = kinds.parse(req.params.kind);
    const id = idSchema.parse(req.params.id);
    const input = recordInput.parse(req.body);
    input.payload = (
      kind === "reports" ? reportSchema : inspectionSchema
    ).parse(input.payload);
    res.json({ item: await saveEntry(kind, id, input, req.user!) });
  },
};
