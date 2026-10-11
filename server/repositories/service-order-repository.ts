import {
  reportTeam,
  dayPeriods,
  hasPeriodData,
  type Entry,
} from "../../contracts/domain.js";
import { reference } from "./catalog-repository.js";
import { fileLink, prepareRecordSave } from "./record-common.js";
import {
  recordRows,
  entryFromRow,
  eqSnapshot,
  snap,
  type RecordFilter,
} from "./record-query.js";
import {
  type DB,
  upsert,
  insert,
  year,
  numeric,
  nullable,
  date,
  readingColumns,
  textNAColumns,
  bool,
  audit,
  yesNo,
  reading,
  time,
  isoDate,
  stamp,
  mediaDTO,
} from "../relational-utils.js";

export async function readServiceOrders(
  db: DB,
  filter: RecordFilter = {},
): Promise<Entry[]> {
  const { rows, children } = await recordRows(db, "reports", filter);
  return rows.map((r: any) => {
    const own = (t: string) =>
      children[t].filter((x) => x.service_order_id === r.id);
    const team = own("service_order_team"),
      files = own("service_order_files");
    const signature = (purpose: string) => {
      const f = files.find((f) => f.purpose === purpose);
      return f ? mediaDTO(f) : undefined;
    };
    const payload = {
      type: r.type,
      operator: r.operator,
      requester: r.requester,
      location: r.location,
      equipment: eqSnapshot(r),
      auxiliaries: team
        .filter((t) => t.role === "auxiliary")
        .map((t) => t.technician_id),
      additionalTechnicians: team
        .slice(1)
        .map((t) => ({ technicianId: t.technician_id, role: t.role })),
      teamSnapshot: team.map((t) => ({
        technicianId: t.technician_id,
        role: t.role,
        name: t.technician_name,
        identifier: t.technician_cpf,
      })),
      auxiliaryNames: team
        .filter((t) => t.role === "auxiliary")
        .map((t) => t.technician_name),
      reasons: own("service_order_reasons").map((reason) => ({
        id: reason.id,
        description: reason.description,
        pending: reason.pending,
        services: own("service_order_services")
          .filter((s) => s.reason_id === reason.id)
          .map((s) => ({
            id: s.id,
            description: s.description,
            notes: s.notes,
            photos: files.filter((f) => f.service_id === s.id).map(mediaDTO),
          })),
      })),
      parts: own("service_order_parts").map((p) => ({
        id: p.id,
        catalogId: p.part_id || undefined,
        code: p.code,
        description: p.description,
        supplier: p.supplier,
        quantity: Number(p.quantity),
        kind: p.kind,
        codeHistory: own("service_order_part_codes")
          .filter((c) => c.service_order_part_id === p.id)
          .map((c) => c.code),
      })),
      days: own("service_order_days").map((d) => ({
        id: d.id,
        date: isoDate(d.date),
        notes: d.notes,
        participants: d.participants_defined
          ? own("service_order_day_participants")
              .filter((x) => x.day_id === d.id)
              .map((x) => ({
                technicianId: x.technician_id,
                present: x.present,
                sameHoursAs: x.same_hours_as,
                sameVehicleAs: x.same_vehicle_as,
                odometerStart: reading(x, "odometer_start"),
                odometerEnd: reading(x, "odometer_end"),
                periods: own("service_order_participant_periods")
                  .filter(
                    (p) =>
                      p.day_id === d.id && p.technician_id === x.technician_id,
                  )
                  .map((p) => ({
                    id: p.id,
                    kind: p.kind,
                    start: time(p.start_time),
                    end: time(p.end_time),
                    pauseMinutes:
                      p.pause_minutes == null
                        ? ""
                        : String(Number(p.pause_minutes)),
                  })),
              }))
          : undefined,
        odometerStart: reading(d, "odometer_start"),
        odometerEnd: reading(d, "odometer_end"),
        hourmeter: reading(d, "hourmeter_lower"),
        hourmeterLower: reading(d, "hourmeter_lower"),
        hourmeterUpper: reading(d, "hourmeter_upper"),
        outbound: {
          start: time(d.outbound_start),
          end: time(d.outbound_end),
        },
        work: { start: time(d.work_start), end: time(d.work_end) },
        inbound: { start: time(d.inbound_start), end: time(d.inbound_end) },
        pause: {
          period: d.pause_period,
          minutes:
            d.pause_minutes == null ? "" : String(Number(d.pause_minutes)),
        },
        periods: own("service_order_day_periods")
          .filter((period) => period.day_id === d.id)
          .map((period) => ({
            id: period.id,
            kind: period.kind,
            start: time(period.start_time),
            end: time(period.end_time),
            pauseMinutes:
              period.pause_minutes == null
                ? ""
                : String(Number(period.pause_minutes)),
          })),
      })),
      concluded: yesNo(r.concluded),
      released: yesNo(r.released),
      photosSent: yesNo(r.photos_sent),
      observations: r.observations,
      technicianSignature: signature("technician_signature"),
      clientSignature: signature("client_signature"),
      clientSnapshot: snap(r.client_id, r.client_name, r.client_cnpj),
      technicianSnapshot: team[0]
        ? snap(
            team[0].technician_id,
            team[0].technician_name,
            team[0].technician_cpf,
          )
        : null,
    };
    return entryFromRow(r, "reports", payload);
  });
}

export async function saveServiceOrder(
  db: DB,
  id: string,
  input: any,
  userId: string,
) {
  const { before, common, p, oldTeam } = await prepareRecordSave(
    db,
    "reports",
    id,
    input,
    userId,
    readServiceOrders,
  );
  const eq = p.equipment;
  await upsert(db, "service_orders", {
    ...common,
    type: p.type,
    operator: p.operator,
    requester: p.requester,
    location: p.location,
    equipment_type: eq.type || "",
    equipment_brand: eq.brand || "",
    equipment_model: eq.model || "",
    equipment_serial: eq.serial || "",
    equipment_year: year(eq.year),
    ...textNAColumns("equipment_plate", eq.plate),
    ...textNAColumns("equipment_fleet", eq.fleet),
    ...readingColumns("odometer", eq.odometer),
    ...readingColumns("hourmeter_lower", eq.hourmeterLower ?? eq.hourmeter),
    ...readingColumns("hourmeter_upper", eq.hourmeterUpper),
    concluded: bool(p.concluded),
    released: bool(p.released),
    photos_sent: bool(p.photosSent),
    observations: p.observations,
  });
  // Replace only this aggregate's children; files themselves are not deleted.
  for (const table of [
    "service_order_files",
    "service_order_reasons",
    "service_order_parts",
    "service_order_days",
    "service_order_team",
  ])
    await db.query(`DELETE FROM ${table} WHERE service_order_id=$1`, [id]);
  const parent = { service_order_id: id };
  for (const [position, member] of reportTeam(input)
    .filter((m) => m.technicianId)
    .entries()) {
    const person = await reference(
      db,
      member.technicianId,
      "technicians",
      oldTeam.some((t) => t.technicianId === member.technicianId),
    );
    const snapshot = before?.payload.teamSnapshot?.find(
      (t: any) => t.technicianId === member.technicianId,
    );
    await insert(db, "service_order_team", {
      ...parent,
      technician_id: member.technicianId,
      position,
      role: member.role,
      technician_name: snapshot?.name || person!.name,
      technician_cpf: snapshot?.identifier || person!.identifier,
    });
  }
  for (const [position, r] of p.reasons.entries()) {
    await insert(db, "service_order_reasons", {
      ...parent,
      id: r.id,
      position,
      description: r.description,
      pending: r.pending,
    });
    for (const [spos, s] of r.services.entries()) {
      await insert(db, "service_order_services", {
        ...parent,
        reason_id: r.id,
        id: s.id,
        position: spos,
        description: s.description,
        notes: s.notes,
      });
      for (const [fpos, f] of s.photos.entries())
        await fileLink(
          db,
          "service_order_files",
          parent,
          f,
          fpos,
          "service_photo",
          { service_id: s.id },
        );
    }
  }
  for (const [position, part] of p.parts.entries()) {
    if (part.catalogId)
      await reference(
        db,
        part.catalogId,
        "parts",
        before?.payload.parts.some((v: any) => v.catalogId === part.catalogId),
      );
    await insert(db, "service_order_parts", {
      ...parent,
      id: part.id,
      part_id: part.catalogId || null,
      position,
      code: part.code,
      description: part.description,
      supplier: part.supplier,
      quantity: numeric(part.quantity, "Quantidade"),
      kind: part.kind,
    });
    const oldPart = before?.payload.parts.find(
      (v: any) =>
        v.id === part.id &&
        v.catalogId === part.catalogId &&
        v.code === part.code,
    );
    const history: string[] = oldPart?.codeHistory ?? part.codeHistory;
    for (const [position, code] of [...new Set(history)].entries())
      await insert(db, "service_order_part_codes", {
        ...parent,
        service_order_part_id: part.id,
        code,
        position,
      });
  }
  for (const [position, day] of p.days.entries()) {
    await insert(db, "service_order_days", {
      ...parent,
      id: day.id,
      position,
      date: date(day.date),
      notes: day.notes || "",
      participants_defined: day.participants !== undefined,
      ...readingColumns("odometer_start", day.odometerStart),
      ...readingColumns("odometer_end", day.odometerEnd),
      ...readingColumns("hourmeter_lower", day.hourmeterLower ?? day.hourmeter),
      ...readingColumns("hourmeter_upper", day.hourmeterUpper),
      outbound_start: nullable(day.outbound.start),
      outbound_end: nullable(day.outbound.end),
      work_start: nullable(day.work.start),
      work_end: nullable(day.work.end),
      inbound_start: nullable(day.inbound.start),
      inbound_end: nullable(day.inbound.end),
      pause_period: day.pause.period,
      pause_minutes: nullable(day.pause.minutes),
    });
    for (const [position, period] of dayPeriods(day)
      .filter(hasPeriodData)
      .entries())
      await insert(db, "service_order_day_periods", {
        ...parent,
        day_id: day.id,
        id: period.id,
        position,
        kind: period.kind,
        start_time: nullable(period.start),
        end_time: nullable(period.end),
        pause_minutes: nullable(period.pauseMinutes),
      });
    for (const [position, person] of (day.participants || []).entries()) {
      await insert(db, "service_order_day_participants", {
        ...parent,
        day_id: day.id,
        technician_id: person.technicianId,
        position,
        present: person.present,
        same_hours_as: person.sameHoursAs,
        same_vehicle_as: person.sameVehicleAs,
        ...readingColumns("odometer_start", person.odometerStart),
        ...readingColumns("odometer_end", person.odometerEnd),
      });
      for (const [position, period] of person.periods.entries())
        await insert(db, "service_order_participant_periods", {
          ...parent,
          day_id: day.id,
          technician_id: person.technicianId,
          position,
          id: period.id,
          kind: period.kind,
          start_time: nullable(period.start),
          end_time: nullable(period.end),
          pause_minutes: nullable(period.pauseMinutes),
        });
    }
  }
  if (p.technicianSignature)
    await fileLink(
      db,
      "service_order_files",
      parent,
      p.technicianSignature,
      0,
      "technician_signature",
    );
  if (p.clientSignature)
    await fileLink(
      db,
      "service_order_files",
      parent,
      p.clientSignature,
      0,
      "client_signature",
    );
  const saved = (await readServiceOrders(db, { id }))[0];
  await audit(db, userId, "service_orders", id, "save", before, saved);
  return saved;
}
