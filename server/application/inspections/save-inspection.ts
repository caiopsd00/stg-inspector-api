import { z } from "zod";
import type { Inspection } from "../../../contracts/types.js";
import type { User } from "../../auth.js";
import { normalizeInspection } from "../../domain/inspection-rules.js";
import { saveInspection } from "../../repositories/inspection-repository.js";
import { fail } from "../../relational-utils.js";
import type { recordInput } from "../../validation.js";
import { saveRecordKind } from "../record-workflow.js";

export function saveInspectionEntry(
  id: string,
  input: z.infer<typeof recordInput>,
  user: User,
) {
  if (
    input.payload.formRevision !== 2 &&
    !z.string().date().safeParse(input.date).success
  )
    throw fail(422, "Data inválida.");
  normalizeInspection(input.payload as Inspection);
  return saveRecordKind("inspections", id, input, user, saveInspection);
}
