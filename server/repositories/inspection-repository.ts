import {
  normalizeInspectionResult,
  templateInspectionSections,
} from "../../contracts/inspection-template.js";
import type { Entry } from "../../contracts/domain.js";
import { reference } from "./catalog-repository.js";
import { fileLink, prepareRecordSave } from "./record-common.js";
import {
  recordRows,
  entryFromRow,
  snap,
  type RecordFilter,
} from "./record-query.js";
import {
  type DB,
  upsert,
  insert,
  year,
  date,
  readingColumns,
  fail,
  audit,
  reading,
  brDate,
  isoDate,
  stamp,
  mediaDTO,
} from "../relational-utils.js";

export async function readInspections(
  db: DB,
  filter: RecordFilter = {},
): Promise<Entry[]> {
  const { rows, children } = await recordRows(db, "inspections", filter);
  return rows.map((r: any) => {
    const items = children.inspection_items.filter(
        (i) => i.inspection_id === r.id,
      ),
      files = children.inspection_files.filter((f) => f.inspection_id === r.id);
    const images = (purpose: string) =>
      files.filter((f) => f.purpose === purpose).map(mediaDTO);
    const documentImages: Record<string, any[]> = {
      "013": images("equipment_photo"),
      "014": images("technical_document"),
    };
    for (const f of files.filter((f) => f.purpose === "extra_photo"))
      (documentImages[f.slot_code] ??= []).push(mediaDTO(f));
    const sections: any[] = [];
    for (const item of items) {
      let section = sections.find((s) => s.id === item.section_id);
      if (!section) {
        section = { id: item.section_id, name: item.section_name, items: [] };
        sections.push(section);
      }
      const slots = templateInspectionSections
        .flatMap((s) => s.items)
        .find((i) => i.code === item.code)?.extraImageSlots;
      section.items.push({
        id: item.id,
        code: item.code,
        name: item.description,
        situation: item.situation || "",
        observation: item.observation,
        updatedAt: stamp(item.updated_at),
        ...(slots ? { extraImageSlots: slots } : {}),
        images: files
          .filter(
            (f) => f.purpose === "item_photo" && f.item_code === item.code,
          )
          .map(mediaDTO),
      });
    }
    // The numeric slots are a template adapter, not persisted fields/JSON.
    const payload = {
      id: r.id,
      name: r.name,
      createdAt: stamp(r.created_at),
      updatedAt: stamp(r.updated_at),
      finalizedAt: stamp(r.finalized_at) || null,
      documentFields: {
        "000": r.number,
        "001": r.equipment_type,
        "002": r.equipment_model,
        "003": r.equipment_serial,
        "004": r.nominal_capacity,
        "005": r.equipment_year == null ? "" : String(r.equipment_year),
        "006": reading(r, "hourmeter"),
        "007": reading(r, "odometer"),
        "008": r.plate_fleet,
        "009": r.performed_by || r.technician_name || r.examiner,
        "010": brDate(r.inspection_date),
        "011": normalizeInspectionResult(r.result),
        "012": brDate(r.next_inspection_date),
        "164": r.performed_by || r.technician_name || r.examiner,
        "165": r.approved_by,
      },
      documentImages,
      sections,
      signature: images("signature")[0] || images("client_signature")[0],
      technicianSignature: images("technician_signature")[0],
      clientSignature: images("client_signature")[0] || images("signature")[0],
      approvedByTechnicianId: r.approved_by_technician_id || null,
      templateVersion: r.template_version,
      clientSnapshot: snap(r.client_id, r.client_name, r.client_cnpj),
      technicianSnapshot: snap(
        r.technician_id,
        r.technician_name,
        r.technician_cpf,
      ),
    };
    return entryFromRow(r, "inspections", payload);
  });
}

export async function saveInspection(
  db: DB,
  id: string,
  input: any,
  userId: string,
) {
  const { before, common, p, tech, equipment } = await prepareRecordSave(
    db,
    "inspections",
    id,
    input,
    userId,
    readInspections,
  );
  const f = p.documentFields,
    techSnapshot =
      before?.technicianId === input.technicianId
        ? before?.payload.technicianSnapshot
        : tech,
    approverId = Object.prototype.hasOwnProperty.call(
      p,
      "approvedByTechnicianId",
    )
      ? p.approvedByTechnicianId || null
      : before?.payload.approvedByTechnicianId || null,
    approver = await reference(
      db,
      approverId,
      "technicians",
      before?.payload.approvedByTechnicianId === approverId,
    ),
    performedBy = f["164"] || techSnapshot?.name || tech?.name || "";
  await upsert(db, "inspections", {
    ...common,
    name: p.name || "",
    technician_id: input.technicianId,
    technician_name: performedBy || null,
    technician_cpf: techSnapshot?.identifier || tech?.identifier || null,
    equipment_type: f["001"] || "",
    equipment_brand: equipment?.data.brand || "",
    equipment_model: f["002"] || "",
    equipment_serial: f["003"] || "",
    equipment_year: year(f["005"]),
    nominal_capacity: f["004"] || "",
    plate_fleet: f["008"] || "",
    examiner: performedBy,
    inspection_date: date(f["010"], true),
    next_inspection_date: date(f["012"], true),
    result: normalizeInspectionResult(f["011"] || ""),
    performed_by: performedBy,
    approved_by: approver?.name || f["165"] || "",
    approved_by_technician_id: approverId,
    ...readingColumns("odometer", f["007"]),
    ...readingColumns("hourmeter", f["006"]),
  });
  await db.query("DELETE FROM inspection_files WHERE inspection_id=$1", [id]);
  await db.query("DELETE FROM inspection_items WHERE inspection_id=$1", [id]);
  const parent = { inspection_id: id };
  for (const [section_position, s] of p.sections.entries())
    for (const [position, item] of s.items.entries()) {
      await insert(db, "inspection_items", {
        ...parent,
        code: item.code,
        id: item.id,
        section_id: s.id,
        section_name: s.name,
        section_position,
        position,
        description: item.name,
        situation: item.situation || null,
        observation: item.observation,
        updated_at: item.updatedAt ? new Date(item.updatedAt) : null,
      });
      for (const [fpos, f] of item.images.entries())
        await fileLink(db, "inspection_files", parent, f, fpos, "item_photo", {
          item_code: item.code,
        });
    }
  for (const [slot, images] of Object.entries(p.documentImages) as [
    string,
    any[],
  ][]) {
    const item = p.sections
      .flatMap((s: any) => s.items)
      .find((i: any) => i.extraImageSlots?.includes(slot));
    const purpose =
      slot === "013"
        ? "equipment_photo"
        : slot === "014"
          ? "technical_document"
          : item
            ? "extra_photo"
            : null;
    if (!purpose && images.length)
      throw fail(422, "Campo de imagem não pertence ao template oficial.");
    for (const [position, image] of images.entries())
      await fileLink(
        db,
        "inspection_files",
        parent,
        image,
        position,
        purpose!,
        item ? { item_code: item.code, slot_code: slot } : {},
      );
  }
  const technicianSignature =
    p.technicianSignature === null
      ? undefined
      : p.technicianSignature || before?.payload.technicianSignature;
  const clientSignature =
    p.clientSignature === null
      ? undefined
      : p.clientSignature || p.signature || before?.payload.clientSignature;
  if (technicianSignature)
    await fileLink(
      db,
      "inspection_files",
      parent,
      technicianSignature,
      0,
      "technician_signature",
    );
  if (clientSignature)
    await fileLink(
      db,
      "inspection_files",
      parent,
      clientSignature,
      0,
      p.signature && !p.clientSignature ? "signature" : "client_signature",
    );
  const saved = (await readInspections(db, { id }))[0];
  await audit(db, userId, "inspections", id, "save", before, saved);
  return saved;
}
