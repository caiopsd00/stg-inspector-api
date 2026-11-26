import {
  validateReport,
  validateReportTeam,
  type Entry,
  type Kind,
  type Report,
} from "../../contracts/domain.js";
import type { Inspection } from "../../contracts/types.js";
import { fail } from "../relational-utils.js";
import { validateInspectionCompletion } from "./inspection-rules.js";

export function validateRecordCompletion(
  kind: Kind,
  record: Pick<Entry, "payload" | "clientId" | "technicianId" | "number">,
) {
  try {
    if (!record.number.trim()) throw Error("Informe o número da O.S.");
    if (kind === "reports") {
      validateReportTeam(record);
      validateReport(record.payload as Report, true);
    } else {
      validateInspectionCompletion(record.payload as Inspection);
    }
    if (!record.clientId || !record.technicianId)
      throw Error("Selecione cliente e técnico antes de finalizar.");
  } catch (error) {
    throw fail(422, (error as Error).message);
  }
}
