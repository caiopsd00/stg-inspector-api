import type { User } from "../../auth.js";
import type { RecordFilter } from "../../repositories/record-query.js";
import { readServiceOrders } from "../../repositories/service-order-repository.js";
import { listRecordKind } from "../record-workflow.js";

export function listServiceOrders(user: User, filter: RecordFilter = {}) {
  return listRecordKind(user, filter, readServiceOrders);
}
