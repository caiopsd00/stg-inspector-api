import type { Request, Response } from "express";
import { z } from "zod";

import { createDocumentService, validateWorkingDocumentLinks } from "../application/document-service.js";
import { listRecords } from "../application/record-service.js";
import { fail } from "../relational-utils.js";
import { idSchema, inspectionSchema, kinds, reportSchema } from "../validation.js";
import { documentFilename } from "../../contracts/domain.js";
import { validateRecordCompletion } from "../domain/record-completion.js";

export function createDocumentsController() {
  const generate = createDocumentService();
  return {
    async download(req: Request, res: Response) {
      const kind = kinds.parse(req.params.kind);
      const id = idSchema.parse(req.params.id);
      const format = z.enum(["pdf", "docx"]).parse(req.params.format);
      const item = (await listRecords(kind, req.user!, { id }))[0];
      if (!item) throw fail(404, "Registro não encontrado.");
      if (format === "pdf" || "workingCopy" in item) {
        validateRecordCompletion(kind, item);
        if ("workingCopy" in item) {
          const shape = kind === "reports" ? reportSchema : inspectionSchema;
          if (!shape.safeParse(item.payload).success)
            throw fail(422, "Confira os campos do formulário antes de gerar o documento.");
          await validateWorkingDocumentLinks(item);
        }
      }
      const result = await generate({
        ...item,
        payload: "documentSignatures" in item
          ? { ...item.payload, ...item.documentSignatures as object }
          : item.payload,
      }, format);
      res.attachment(documentFilename(item.clientName, item.number, format));
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
