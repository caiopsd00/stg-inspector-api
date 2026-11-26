import type { Request, Response } from "express";
import { z } from "zod";

import { listRecords, saveEntry } from "../application/record-service.js";
import { fail } from "../relational-utils.js";
import { pool } from "../db.js";
import { recordTables } from "../repositories/record-access.js";
import {
  idSchema,
  inspectionSchema,
  kinds,
  recordFilter,
  recordInput,
  reportSchema,
  workingInspectionSchema,
  workingReportSchema,
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
    const working = input.saveIntent === "draft";
    if (!working)
      input.number = z.string().trim().min(1, "Número obrigatório.").parse(input.number);
    input.payload = (
      kind === "reports"
        ? working ? workingReportSchema : reportSchema
        : working ? workingInspectionSchema : inspectionSchema
    ).parse(input.payload);
    res.json({ item: await saveEntry(kind, id, input, req.user!) });
  },
  async startFilling(req: Request, res: Response) {
    const kind = kinds.parse(req.params.kind);
    const id = idSchema.parse(req.params.id);
    await pool.query(
      `INSERT INTO record_fill_starts(kind,record_id,user_id)
       SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM ${recordTables[kind]} WHERE id=$2)
       ON CONFLICT DO NOTHING`,
      [kind, id, req.user!.id],
    );
    res.sendStatus(204);
  },
};
