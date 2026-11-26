import { z } from "zod";
import {
  hasDayData,
  validateReportTeam,
  type Report,
} from "../../../contracts/domain.js";
import type { User } from "../../auth.js";
import { fail } from "../../relational-utils.js";
import { saveServiceOrder } from "../../repositories/service-order-repository.js";
import type { recordInput } from "../../validation.js";
import { saveRecordKind } from "../record-workflow.js";

export function saveServiceOrderEntry(
  id: string,
  input: z.infer<typeof recordInput>,
  user: User,
) {
  if (
    input.payload.formRevision !== 2 &&
    !z.string().date().safeParse(input.date).success
  )
    throw fail(422, "Data inválida.");
  try {
    validateReportTeam(input);
  } catch (error) {
    throw fail(422, (error as Error).message);
  }
  input.payload.days = (input.payload as Report).days.filter(hasDayData);
  return saveRecordKind("reports", id, input, user, saveServiceOrder);
}
