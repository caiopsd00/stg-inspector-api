import { z } from "zod";
import {
  hasDayData,
  validateReport,
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
  if (!z.string().date().safeParse(input.date).success)
    throw fail(422, "Data inválida.");
  try {
    validateReportTeam(input);
    validateReport(input.payload as Report, input.status === "finalized");
  } catch (error) {
    throw fail(422, (error as Error).message);
  }
  input.payload.days = (input.payload as Report).days.filter(hasDayData);
  if (input.status === "finalized" && (!input.clientId || !input.technicianId))
    throw fail(422, "Selecione cliente e técnico antes de finalizar.");
  return saveRecordKind("reports", id, input, user, saveServiceOrder);
}
