export type Kind = "reports" | "inspections";
export type CatalogKind = "clients" | "technicians" | "equipment" | "parts";
export type Media = {
  id?: string;
  uri: string;
  name: string;
  width?: number;
  height?: number;
  createdAt?: string;
};
export type Catalog = {
  id: string;
  kind: CatalogKind;
  name: string;
  identifier: string | null;
  clientId: string | null;
  data: Record<string, any>;
  active: boolean;
  version: number;
};
export type Period = { start: string; end: string };
export type PeriodKind = "outbound" | "work" | "inbound";
export type DayPeriod = Period & {
  id: string;
  kind: PeriodKind;
  pauseMinutes: string;
};
export const periodLabels: Record<PeriodKind, string> = {
  outbound: "Deslocamento de ida",
  work: "Trabalho",
  inbound: "Deslocamento de volta",
};
export type DayParticipant = {
  technicianId: string;
  present: boolean;
  odometerStart: string;
  odometerEnd: string;
  periods: DayPeriod[];
  sameHoursAs: string | null;
  sameVehicleAs: string | null;
};
export type Day = {
  id: string;
  date: string;
  odometerStart: string;
  odometerEnd: string;
  hourmeter: string;
  hourmeterLower?: string;
  hourmeterUpper?: string;
  outbound: Period;
  work: Period;
  inbound: Period;
  pause: { period: "outbound" | "work" | "inbound"; minutes: string };
  /** Canonical schedule. Legacy fields remain only for existing/offline records. */
  periods?: DayPeriod[];
  notes?: string;
  /** Undefined only for legacy schedules with a single, unassigned timeline. */
  participants?: DayParticipant[];
};
export type Service = {
  id: string;
  description: string;
  notes: string;
  photos: Media[];
};
export type Reason = {
  id: string;
  description: string;
  services: Service[];
  pending: string;
};
export type Part = {
  id: string;
  catalogId?: string;
  code: string;
  description: string;
  supplier: string;
  quantity: number;
  kind: "requested" | "replaced";
  codeHistory: string[];
};
export type TeamMember = {
  technicianId: string;
  role: "technician" | "auxiliary";
};
export type Report = {
  type: string;
  operator: string;
  requester: string;
  location: string;
  auxiliaries: string[];
  // Optional for reports created before per-person roles were introduced.
  additionalTechnicians?: TeamMember[];
  equipment: Record<string, string>;
  reasons: Reason[];
  parts: Part[];
  days: Day[];
  concluded: string;
  released: string;
  photosSent: string;
  observations: string;
  technicianSignature?: Media;
  clientSignature?: Media;
};
export type Entry = {
  id: string;
  kind: Kind;
  number: string;
  clientId: string | null;
  technicianId: string | null;
  equipmentId: string | null;
  clientName?: string;
  technicianName?: string;
  date: string;
  status: "draft" | "finalized";
  payload: any;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export const equipmentFields = [
  ["type", "Tipo"],
  ["brand", "Marca"],
  ["model", "Modelo"],
  ["serial", "Série/chassi"],
  ["nominalCapacity", "Capacidade nominal"],
  ["year", "Ano de fabricação"],
  ["plate", "Placa"],
  ["fleet", "Frota"],
] as const;
export const equipmentTypes = ["Guindaste", "Caminhão Munck", "PTA", "Outro"];
// Editing the selected client must not discard the equipment or its readings.
export function changeEntryClient(
  entry: Entry,
  clientId: string | null,
): Entry {
  if (clientId === entry.clientId) return entry;
  const documentFields = { ...entry.payload.documentFields };
  for (const key of ["001", "002", "003", "004", "005", "006", "007", "008"])
    documentFields[key] = "";
  return {
    ...entry,
    clientId,
    equipmentId: null,
    payload:
      entry.kind === "reports"
        ? { ...entry.payload, equipment: {} }
        : { ...entry.payload, documentFields },
  };
}
export function permanentEquipment(
  data: Record<string, unknown> = {},
): Record<string, string> {
  return Object.fromEntries(
    equipmentFields.map(([key]) => [
      key,
      typeof data[key] === "string" ? data[key] : "",
    ]),
  );
}
export function validateEquipment(data: Record<string, string>) {
  for (const [key, label] of equipmentFields.slice(0, 4))
    if (!data[key]?.trim())
      throw Error(`Informe ${label.toLowerCase()} do equipamento.`);
}
export function hasReportTravel(p: Report) {
  return p.days.some((d) =>
    d.participants !== undefined
      ? d.participants
          .filter((x) => x.present)
          .some((x) => {
            const resolved = participantDay(d, x.technicianId);
            return Boolean(
              resolved.odometerStart ||
              resolved.odometerEnd ||
              dayPeriods(resolved).some(
                (p) => p.kind !== "work" && hasPeriodData(p),
              ),
            );
          })
      : Boolean(
          d.odometerStart ||
          d.odometerEnd ||
          dayPeriods(d).some(
            (period) => period.kind !== "work" && hasPeriodData(period),
          ),
        ),
  );
}
export function changeReportType(p: Report, type: string): Report {
  if (type !== "interno") return { ...p, type };
  return {
    ...p,
    type,
    location: "Galpão BR LIFT",
    days: p.days.map((d) => ({
      ...d,
      odometerStart: "",
      odometerEnd: "",
      outbound: { start: "", end: "" },
      inbound: { start: "", end: "" },
      periods: dayPeriods(d).filter((period) => period.kind === "work"),
      participants: d.participants?.map((x) => ({
        ...x,
        odometerStart: "",
        odometerEnd: "",
        sameVehicleAs: null,
        periods: x.periods.filter((p) => p.kind === "work"),
      })),
      pause: {
        period: "work",
        minutes: d.pause.period === "work" ? d.pause.minutes : "",
      },
    })),
  };
}
function hasNumericReading(value?: string) {
  return value != null && value !== "" && value !== "N/A";
}
export function reportTeam(
  entry: Pick<Entry, "technicianId" | "payload">,
): TeamMember[] {
  const p = entry.payload as Report;
  const additional =
    p.additionalTechnicians ??
    [...new Set(p.auxiliaries || [])]
      .filter((id) => id !== entry.technicianId)
      .map((technicianId) => ({ technicianId, role: "auxiliary" as const }));
  return [
    { technicianId: entry.technicianId || "", role: "technician" },
    ...additional,
  ];
}
export function withReportTeam<
  T extends Pick<Entry, "technicianId" | "payload">,
>(entry: T, team: TeamMember[]): T {
  const additionalTechnicians = team.slice(1).map((member) => ({ ...member }));
  return {
    ...entry,
    technicianId: team[0]?.technicianId || null,
    payload: {
      ...entry.payload,
      days: (entry.payload.days || []).map((day: Day) => {
        if (day.participants === undefined) return day;
        let current = day;
        for (const person of day.participants)
          if (!team.some((m) => m.technicianId === person.technicianId))
            current = {
              ...current,
              participants: setDayPresence(current, person.technicianId, false),
            };
        return {
          ...current,
          participants: current.participants!.filter((p) =>
            team.some((m) => m.technicianId === p.technicianId),
          ),
        };
      }),
      additionalTechnicians,
      auxiliaries: additionalTechnicians
        .filter((m) => m.role === "auxiliary")
        .map((m) => m.technicianId),
    },
  };
}
export function validateReportTeam(
  entry: Pick<Entry, "technicianId" | "payload">,
) {
  const team = reportTeam(entry);
  if (team.length > 1 && team.some((m) => !m.technicianId))
    throw Error(
      "Selecione todos os profissionais da equipe ou remova as linhas vazias.",
    );
  const ids = team.map((m) => m.technicianId).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    throw Error("Um profissional não pode aparecer mais de uma vez na equipe.");
  for (const day of (entry.payload as Report).days)
    for (const person of day.participants || [])
      if (!ids.includes(person.technicianId))
        throw Error(
          "Há profissional no cronograma que não pertence mais à equipe. Revise a participação nesse dia.",
        );
}
export function newReport(): Report {
  return {
    type: "externo",
    operator: "",
    requester: "",
    location: "",
    auxiliaries: [],
    equipment: {},
    reasons: [],
    parts: [],
    days: [],
    concluded: "",
    released: "",
    photosSent: "",
    observations: "",
  };
}
export function newDay(id: string): Day {
  return {
    id,
    date: localDate(),
    odometerStart: "",
    odometerEnd: "",
    hourmeter: "",
    hourmeterLower: "",
    hourmeterUpper: "",
    outbound: { start: "", end: "" },
    work: { start: "", end: "" },
    inbound: { start: "", end: "" },
    pause: { period: "work", minutes: "" },
  };
}
export function localDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function periodMinutes(p?: Period) {
  if (!p?.start || !p.end) return 0;
  const parse = (s: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))
      throw new Error("Horário inválido.");
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const diff = parse(p.end) - parse(p.start);
  return diff < 0 ? diff + 1440 : diff;
}
export function dayPeriods(d: Day): DayPeriod[] {
  if (d.periods !== undefined) return d.periods;
  return (["outbound", "work", "inbound"] as const)
    .map((kind) => ({
      id: `${d.id}-${kind}`,
      kind,
      ...d[kind],
      pauseMinutes: d.pause.period === kind ? d.pause.minutes : "",
    }))
    .filter(hasPeriodData);
}
export function hasPeriodData(p: DayPeriod) {
  return Boolean(p.start || p.end || p.pauseMinutes);
}
export function periodNetMinutes(p: DayPeriod) {
  for (const time of [p.start, p.end])
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw Error("Horário inválido.");
  const duration = periodMinutes(p),
    pause = Number(p.pauseMinutes || 0);
  if (!Number.isFinite(pause) || pause < 0 || pause > duration)
    throw Error("A pausa não pode ultrapassar o período relacionado.");
  return duration - pause;
}
export function hasDayData(d: Day) {
  if (d.participants !== undefined)
    return Boolean(d.notes?.trim() || d.participants.length);
  return Boolean(
    d.notes?.trim() ||
    d.odometerStart ||
    d.odometerEnd ||
    d.hourmeter ||
    d.hourmeterLower ||
    d.hourmeterUpper ||
    dayPeriods(d).some(hasPeriodData),
  );
}
export function dayTotals(d: Day): {
  work: number;
  travel: number;
  km: number;
} {
  if (d.participants !== undefined) {
    validateDayParticipants(d);
    return d.participants
      .filter((x) => x.present)
      .reduce(
        (total, person) => {
          const t = participantTotals(d, person.technicianId);
          return {
            work: total.work + t.work,
            travel: total.travel + t.travel,
            km: total.km + t.km,
          };
        },
        { work: 0, travel: 0, km: 0 },
      );
  }
  const periods = { outbound: 0, work: 0, inbound: 0 };
  for (const period of dayPeriods(d))
    periods[period.kind] += periodNetMinutes(period);
  for (const key of [
    "odometerStart",
    "odometerEnd",
    "hourmeter",
    "hourmeterLower",
    "hourmeterUpper",
  ] as const)
    if (
      hasNumericReading(d[key]) &&
      (!Number.isFinite(Number(d[key])) || Number(d[key]) < 0)
    )
      throw new Error("Leituras devem ser números positivos.");
  if (
    hasNumericReading(d.odometerStart) &&
    hasNumericReading(d.odometerEnd) &&
    Number(d.odometerEnd) < Number(d.odometerStart)
  )
    throw new Error("A leitura final de KM deve ser maior ou igual à inicial.");
  return {
    work: periods.work,
    travel: periods.outbound + periods.inbound,
    km:
      hasNumericReading(d.odometerStart) && hasNumericReading(d.odometerEnd)
        ? Number(d.odometerEnd) - Number(d.odometerStart)
        : 0,
  };
}
export function validateReport(p: Report, finalized: boolean) {
  for (const key of [
    "odometer",
    "hourmeter",
    "hourmeterLower",
    "hourmeterUpper",
  ]) {
    const value = p.equipment?.[key];
    if (
      hasNumericReading(value) &&
      (!Number.isFinite(Number(value)) || Number(value) < 0)
    )
      throw Error("KM e horímetros devem ser números positivos ou N/A.");
  }
  if (
    !Array.isArray(p.reasons) ||
    !Array.isArray(p.parts) ||
    !Array.isArray(p.days)
  )
    throw new Error("Estrutura do atendimento inválida.");
  for (const day of p.days.filter(hasDayData)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date))
      throw new Error("Informe a data de cada dia preenchido.");
    dayTotals(day);
    if (
      finalized &&
      day.participants !== undefined &&
      !day.participants.some((x) => x.present)
    )
      throw Error("Selecione quem trabalhou em cada dia do cronograma.");
    if (
      finalized &&
      day.participants?.some(
        (x) =>
          x.present &&
          !dayPeriods(participantDay(day, x.technicianId)).some(
            (t) => t.start && t.end,
          ),
      )
    )
      throw Error("Informe os horários de cada profissional presente no dia.");
    if (
      finalized &&
      (day.participants === undefined
        ? [day]
        : day.participants
            .filter((x) => x.present)
            .map((x) => participantDay(day, x.technicianId))
      ).some((d) =>
        dayPeriods(d).some((t) => Boolean(t.start) !== Boolean(t.end)),
      )
    )
      throw new Error("Complete início e fim de cada período utilizado.");
  }
  for (const part of p.parts)
    if (
      !part.code.trim() ||
      !Number.isFinite(Number(part.quantity)) ||
      Number(part.quantity) <= 0 ||
      !["requested", "replaced"].includes(part.kind)
    )
      throw new Error(
        "Peças precisam de código, quantidade positiva e classificação.",
      );
  if (finalized) {
    if (p.type === "interno" && hasReportTravel(p))
      throw Error(
        "Atendimento interno não utiliza KM de deslocamento nem períodos de ida/volta. Revise o cronograma.",
      );
    validateEquipment(p.equipment);
    if (!p.reasons.length || p.reasons.some((r) => !r.description.trim()))
      throw new Error("Informe os motivos do serviço.");
    if (
      p.reasons.some(
        (r) =>
          !r.services.length || r.services.some((s) => !s.description.trim()),
      )
    )
      throw new Error(
        "Descreva pelo menos um serviço em cada motivo; remova serviços vazios.",
      );
    if (!p.concluded || !p.released || !p.photosSent)
      throw new Error("Preencha o status final.");
    if (!p.technicianSignature?.uri || !p.clientSignature?.uri)
      throw new Error(
        "Assinaturas do técnico e cliente são obrigatórias para finalizar.",
      );
  }
}
/** Assign legacy hours only to the primary professional, never invent attendance for the rest. */
export function dayParticipants(
  day: Day,
  team: TeamMember[],
): DayParticipant[] {
  if (day.participants !== undefined) return day.participants;
  const primary = team.find((x) => x.technicianId);
  return primary
    ? [
        {
          technicianId: primary.technicianId,
          present: true,
          odometerStart: day.odometerStart,
          odometerEnd: day.odometerEnd,
          periods: dayPeriods(day),
          sameHoursAs: null,
          sameVehicleAs: null,
        },
      ]
    : [];
}
export function participantDay(day: Day, technicianId: string): Day {
  const people = day.participants || [];
  const person = people.find((x) => x.technicianId === technicianId);
  if (!person) throw Error("Profissional não encontrado neste dia.");
  const resolve = (
    id: string,
    field: "sameHoursAs" | "sameVehicleAs",
    seen = new Set<string>(),
  ): DayParticipant => {
    if (seen.has(id))
      throw Error("Referência circular entre profissionais do dia.");
    seen.add(id);
    const p = people.find((x) => x.technicianId === id && x.present);
    if (!p)
      throw Error(
        "O profissional de referência precisa estar presente neste dia.",
      );
    return p[field] ? resolve(p[field]!, field, seen) : p;
  };
  const periodsFor = (
    id: string,
    kind: PeriodKind,
    seen = new Set<string>(),
  ): DayPeriod[] => {
    if (seen.has(id))
      throw Error("Referência circular entre profissionais do dia.");
    seen.add(id);
    const p = people.find((x) => x.technicianId === id && x.present);
    if (!p)
      throw Error(
        "O profissional de referência precisa estar presente neste dia.",
      );
    const reference =
      kind === "work" ? p.sameHoursAs : p.sameVehicleAs || p.sameHoursAs;
    return reference
      ? periodsFor(reference, kind, seen)
      : p.periods.filter((t) => t.kind === kind);
  };
  const vehicle = person.present
    ? resolve(technicianId, "sameVehicleAs")
    : person;
  const periodOrder = [
    ...new Set<PeriodKind>([
      ...dayPeriods(day).map((period) => period.kind),
      ...person.periods.map((period) => period.kind),
      "outbound",
      "work",
      "inbound",
    ]),
  ];
  const periods = person.present
    ? periodOrder.flatMap((kind) => periodsFor(technicianId, kind))
    : person.periods;
  return {
    ...day,
    participants: undefined,
    notes: "",
    hourmeter: "",
    hourmeterLower: "",
    hourmeterUpper: "",
    periods,
    odometerStart: vehicle.odometerStart,
    odometerEnd: vehicle.odometerEnd,
  };
}
export function participantTotals(day: Day, id: string) {
  const t = dayTotals(participantDay(day, id));
  return {
    ...t,
    km: day.participants?.find((p) => p.technicianId === id)?.sameVehicleAs
      ? 0
      : t.km,
  };
}
export function validateDayParticipants(day: Day) {
  const people = day.participants || [];
  if (new Set(people.map((x) => x.technicianId)).size !== people.length)
    throw Error("Profissional repetido no dia.");
  for (const person of people) {
    // Validate independent values too: toggling a shortcut must never expose corrupt saved data.
    dayTotals({
      ...day,
      participants: undefined,
      notes: "",
      hourmeter: "",
      hourmeterLower: "",
      hourmeterUpper: "",
      periods: person.periods,
      odometerStart: person.odometerStart,
      odometerEnd: person.odometerEnd,
    });
    if (person.present) participantDay(day, person.technicianId);
  }
}
/** Leaving a shortcut restores an existing independent schedule, or starts from the linked one. */
export function separateDayHours(
  day: Day,
  id: string,
): Pick<DayParticipant, "sameHoursAs" | "periods"> {
  const person = day.participants?.find((p) => p.technicianId === id);
  if (!person) throw Error("Profissional não encontrado neste dia.");
  return {
    sameHoursAs: null,
    periods: (person.periods.some(hasPeriodData)
      ? person.periods
      : dayPeriods(participantDay(day, id))
    ).map((p) => ({ ...p })),
  };
}
/** Keep previously entered independent travel, otherwise use the shared trip as an editable starting point. */
export function separateDayVehicle(
  day: Day,
  id: string,
): Pick<
  DayParticipant,
  "sameVehicleAs" | "periods" | "odometerStart" | "odometerEnd"
> {
  const person = day.participants?.find((p) => p.technicianId === id);
  if (!person) throw Error("Profissional não encontrado neste dia.");
  const resolved = participantDay(day, id),
    ownTravel = person.periods.filter((p) => p.kind !== "work");
  return {
    sameVehicleAs: null,
    odometerStart: person.odometerStart || resolved.odometerStart,
    odometerEnd: person.odometerEnd || resolved.odometerEnd,
    periods: [
      ...person.periods.filter((p) => p.kind === "work"),
      ...(ownTravel.some(hasPeriodData)
        ? ownTravel
        : dayPeriods(resolved).filter((p) => p.kind !== "work")
      ).map((p) => ({ ...p })),
    ],
  };
}
/** Preserve dependent schedules if the reference leaves; no dangling links or lost hours. */
export function setDayPresence(
  day: Day,
  technicianId: string,
  present: boolean,
): DayParticipant[] {
  const people = day.participants || [];
  if (!people.some((x) => x.technicianId === technicianId))
    return [
      ...people,
      {
        technicianId,
        present,
        periods: [],
        odometerStart: "",
        odometerEnd: "",
        sameHoursAs: null,
        sameVehicleAs: null,
      },
    ];
  return people.map((person) => {
    if (person.technicianId === technicianId)
      return {
        ...person,
        present,
        ...(!present && person.present && person.sameHoursAs
          ? separateDayHours(day, person.technicianId)
          : {}),
        ...(!present ? { sameHoursAs: null, sameVehicleAs: null } : {}),
      };
    if (present) return person;
    const detachedVehicle =
      person.sameVehicleAs === technicianId
        ? separateDayVehicle(day, person.technicianId)
        : {};
    return {
      ...person,
      ...detachedVehicle,
      ...(person.sameHoursAs === technicianId
        ? {
            sameHoursAs: null,
            periods: participantDay(day, person.technicianId).periods!.map(
              (p) => ({ ...p }),
            ),
          }
        : {}),
    };
  });
}
export function digits(value: string) {
  return value.replace(/\D/g, "");
}
export function canonicalDocument(kind: CatalogKind, value: string) {
  const v = kind === "parts" ? value.trim().toUpperCase() : digits(value);
  if (kind === "clients" && v.length !== 14)
    throw new Error("CNPJ precisa ter 14 dígitos.");
  if (kind === "technicians" && v.length !== 11)
    throw new Error("CPF precisa ter 11 dígitos.");
  if (kind === "parts" && !v) throw new Error("Informe o código da peça.");
  return v;
}
