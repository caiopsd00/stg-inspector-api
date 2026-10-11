import type { Request, Response } from "express";
import { z } from "zod";

import { createDocumentService } from "../application/document-service.js";
import { listRecords } from "../application/record-service.js";
import { fail } from "../relational-utils.js";
import { idSchema, kinds } from "../validation.js";

export function createDocumentsController() {
  const generate = createDocumentService();
  return {
    async download(req: Request, res: Response) {
      const kind = kinds.parse(req.params.kind);
      const id = idSchema.parse(req.params.id);
      const format = z.enum(["pdf", "docx"]).parse(req.params.format);
      const item = (await listRecords(kind, req.user!, { id }))[0];
      if (!item) throw fail(404, "Registro não encontrado.");
      const result = await generate(item, format);
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="BR-LIFT-' + id + "." + format + '"',
      );
      res
        .type(
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .send(result);
    },
  };
}
