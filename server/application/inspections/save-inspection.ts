import { z } from "zod";
import type { Inspection } from "../../../contracts/types.js";
import type { User } from "../../auth.js";
import { validateInspection } from "../../domain/inspection-rules.js";
import { saveInspection } from "../../repositories/inspection-repository.js";
import { fail } from "../../relational-utils.js";
import type { recordInput } from "../../validation.js";
import { saveRecordKind } from "../record-workflow.js";

export function saveInspectionEntry(
  id: string,
  input: z.infer<typeof recordInput>,
  user: User,
) {
  if (!z.string().date().safeParse(input.date).success)
    throw fail(422, "Data inválida.");
  validateInspection(input.payload as Inspection, input.status === "finalized");
  if (input.status === "finalized" && (!input.clientId || !input.technicianId))
    throw fail(422, "Selecione cliente e técnico antes de finalizar.");
  return saveRecordKind("inspections", id, input, user, saveInspection);
}
