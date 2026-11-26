import { newReport, reportTeam, type Entry } from "../../contracts/domain.js";
import type { z } from "zod";
import type { recordInput } from "../validation.js";
import { catalogItems } from "./catalog-repository.js";
import { readInspections, saveInspection } from "./inspection-repository.js";
import { readServiceOrders, saveServiceOrder } from "./service-order-repository.js";
import { recordTables, type RecordKind } from "./record-access.js";
import { fail, type DB } from "../relational-utils.js";

type Input = z.infer<typeof recordInput>;

// Keep the operator's working content separate from columns intended to hold
// coherent operational data. Existing repositories still own links, media,
// signature verification, versions, history and authorization.
export async function persistWorkingCopy(
  db: DB, kind: RecordKind, id: string, input: Input, userId: string,
): Promise<Entry> {
  const report = kind === "reports";
  const read = report ? readServiceOrders : readInspections;
  const save = report ? saveServiceOrder : saveInspection;
  const before = (await read(db, { id }))[0];
  if ((before?.version || 0) !== input.baseVersion)
    throw fail(409, "Conflito: existe uma edição mais recente no servidor. Seus dados locais foram preservados.");
  if (before?.status === "finalized" || input.status !== "draft")
    throw fail(422, "Rascunho indisponível para um registro já finalizado.");

  const raw = input.payload;
  const copy = JSON.stringify({
    number: input.number,
    clientId: input.clientId,
    technicianId: input.technicianId,
    equipmentId: input.equipmentId,
    vehicleId: input.vehicleId ?? null,
    payload: raw,
  });
  const catalogId = async (kind: "clients" | "equipment" | "vehicles" | "technicians", id: string | null | undefined) => {
    if (!id) return;
    const item = (await catalogItems(db, kind, { id }))[0];
    const prior = kind === "clients" ? before?.clientId
      : kind === "equipment" ? before?.equipmentId
      : kind === "vehicles" ? before?.vehicleId : before?.technicianId;
    if (item?.active || prior === id ||
        (kind === "technicians" && before?.payload.teamSnapshot?.some((person: any) => person.technicianId === id)))
      return item;
  };
  const client = await catalogId("clients", input.clientId);
  const equipment = await catalogId("equipment", input.equipmentId);
  const vehicle = await catalogId("vehicles", input.vehicleId);
  const media = {
    formRevision: raw.formRevision,
    technicianSignature: raw.technicianSignature,
    clientSignature: raw.clientSignature,
  };
  let projected;
  let technicianId: string | null;
  if (report) {
    const current = reportTeam(input);
    const seen = new Set<string>();
    const members = [];
    for (const member of current) {
      if (!member.technicianId || seen.has(member.technicianId)) continue;
      const person = await catalogId("technicians", member.technicianId);
      if (!person) continue;
      seen.add(member.technicianId);
      members.push(member);
    }
    technicianId = members[0]?.technicianId || null;
    projected = {
      ...newReport(),
      ...media,
      type: raw.type,
      primaryTechnicianRole: members[0]?.role,
      primaryTechnicianCharged: members[0]?.charged,
      additionalTechnicians: members.slice(1),
      reasons: raw.reasons.map((reason: any, i: number) => ({
        ...reason, id: `draft-reason-${i}`,
        services: reason.services.map((service: any, j: number) => ({
          ...service, id: `draft-service-${i}-${j}`,
        })),
      })),
    };
  } else {
    technicianId = (await catalogId("technicians", input.technicianId))?.id || null;
    projected = {
      ...media,
      documentFields: {},
      documentImages: raw.documentImages,
      sections: raw.sections.map((section: any) => ({
        ...section,
        items: section.items.map((item: any) => ({ ...item, id: `draft-check-${item.code}` })),
      })),
      signature: raw.signature,
      days: [],
      approvedByTechnicianId: (await catalogId("technicians", raw.approvedByTechnicianId))?.id || null,
    };
  }
  const previousNumber = before && (await db.query(
    `SELECT number FROM ${recordTables[kind]} WHERE id=$1`, [id],
  )).rows[0]?.number;
  return save(db, id, {
    ...input,
    number: previousNumber ?? null,
    date: before?.date || new Date().toISOString().slice(0, 10),
    technicianId,
    clientId: client?.id || null,
    equipmentId: client && equipment?.clientId === client.id ? equipment.id : null,
    vehicleId: vehicle?.id || null,
    payload: projected,
  }, userId, copy);
}
