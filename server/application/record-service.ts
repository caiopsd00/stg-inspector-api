import type { User } from "../auth.js";
import type { RecordKind } from "../repositories/record-access.js";
import type { RecordFilter } from "../repositories/record-query.js";
import type { z } from "zod";
import type { recordInput } from "../validation.js";
import { listInspections } from "./inspections/list-inspections.js";
import { saveInspectionEntry } from "./inspections/save-inspection.js";
import { listServiceOrders } from "./service-orders/list-service-orders.js";
import { saveServiceOrderEntry } from "./service-orders/save-service-order.js";

export function listRecords(
  kind: RecordKind,
  user: User,
  filter: RecordFilter = {},
) {
  return kind === "reports"
    ? listServiceOrders(user, filter)
    : listInspections(user, filter);
}

export function saveEntry(
  kind: RecordKind,
  id: string,
  input: z.infer<typeof recordInput>,
  user: User,
) {
  return kind === "reports"
    ? saveServiceOrderEntry(id, input, user)
    : saveInspectionEntry(id, input, user);
}
