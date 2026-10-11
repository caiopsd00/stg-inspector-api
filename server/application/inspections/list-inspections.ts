import type { User } from "../../auth.js";
import { readInspections } from "../../repositories/inspection-repository.js";
import type { RecordFilter } from "../../repositories/record-query.js";
import { listRecordKind } from "../record-workflow.js";

export function listInspections(user: User, filter: RecordFilter = {}) {
  return listRecordKind(user, filter, readInspections);
}
