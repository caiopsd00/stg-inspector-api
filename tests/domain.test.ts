import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newDay,
  dayParticipants,
  participantDay,
  setDayPresence,
  separateDayHours,
  newReport,
  hasDayData,
  dayTotals,
  participantTotals,
  dayPeriods,
  validateReport,
  canonicalDocument,
  reportTeam,
  withReportTeam,
  validateReportTeam,
  permanentEquipment,
  validateEquipment,
  changeEntryClient,
  changeReportType,
  hasReportTravel,
  periodContinuityIssues,
  periodSummary,
  formatDuration,
  validateSchedule,
  type DayPeriod,
  type Entry,
} from "../contracts/domain.js";
test("durações usam horas e minutos sem perder segundos ou limitar totais a um dia", () => {
  for (const [minutes, expected] of [
    [0, "0h00min"],
    [5, "0h05min"],
    [60, "1h00min"],
    [90, "1h30min"],
    [360, "6h00min"],
    [780, "13h00min"],
    [1500, "25h00min"],
    [59.5, "0h59min 30s"],
  ] as const)
    assert.equal(formatDuration(minutes), expected);
  for (const invalid of [-1, NaN, Infinity])
    assert.equal(formatDuration(invalid), "—");
});
test("continuidade segue ida, trabalho e volta, sem retroceder KM nem horários", () => {
  const period = (
    id: string,
    kind: DayPeriod["kind"],
    start: string,
    end: string,
    km1: string,
    km2: string,
  ): DayPeriod => ({
    id,
    kind,
    start,
    end,
    pauseMinutes: "15",
    odometerStart: km1,
    odometerEnd: km2,
  });
  const periods = [
    period("work", "work", "09:00", "12:00", "120", "130"),
    period("out1", "outbound", "07:00", "08:00", "0", "100"),
    period("out2", "outbound", "08:00", "09:00", "100", "120"),
    period("back", "inbound", "12:00", "13:00", "130", "150"),
  ];
  assert.deepEqual(periodContinuityIssues(periods), []);
  assert.equal(periodSummary(periods[0]), "2h45min líquidos · 10 km");
  assert.equal(
    periodSummary({
      ...periods[0],
      start: "09:00",
      end: "10:00",
      pauseMinutes: "0.5",
      odometerStart: "100.1",
      odometerEnd: "100.3",
    }),
    "0h59min 30s líquidos · 0,2 km",
  );
  const incomplete = structuredClone(periods);
  incomplete[2].end = "";
  incomplete[0].start = "07:00";
  assert.ok(
    periodContinuityIssues(incomplete).some(
      (e) => e.id === "work" && e.field === "start",
    ),
  );
  periods[2].odometerStart = "5";
  periods[2].start = "07:59";
  const errors = periodContinuityIssues(periods);
  assert.ok(errors.some((e) => e.id === "out2" && e.field === "odometerStart"));
  assert.ok(errors.some((e) => e.id === "out2" && e.field === "start"));
  assert.throws(
    () => validateSchedule([{ ...newDay("d"), periods }], false),
    /KM|início/,
  );
  periods[2].odometerStart = "100";
  periods[2].start = "08:00";
  periods[0].odometerStart = "N/A";
  periods[0].odometerEnd = "N/A";
  periods[3].odometerStart = "5";
  assert.ok(
    periodContinuityIssues(periods).some((e) => e.id === "back"),
    "N/A não apaga a leitura anterior",
  );
});
test("ida, trabalho e volta terminam até 23:59 e continuam em outra data", () => {
  for (const kind of ["outbound", "work", "inbound"] as const) {
    const period: DayPeriod = {
      id: "p",
      kind,
      start: "03:30",
      end: "01:00",
      pauseMinutes: "",
    };
    assert.ok(
      periodContinuityIssues([period]).some(
        (e) => e.field === "end" && /23:59/.test(e.message),
      ),
    );
    assert.match(periodSummary(period), /outro dia/);
    assert.throws(
      () => validateSchedule([{ ...newDay("d"), periods: [period] }], false),
      /23:59/,
    );
    const first = {
      ...newDay("first"),
      date: "2026-11-17",
      periods: [{ ...period, end: "23:59" }],
    };
    const second = {
      ...newDay("second"),
      date: "2026-11-18",
      periods: [{ ...period, start: "00:00", end: "01:00" }],
    };
    assert.doesNotThrow(() => validateSchedule([first, second], true));
    assert.deepEqual(periodContinuityIssues(first.periods), []);
    assert.equal(dayTotals(first)[kind === "work" ? "work" : "travel"], 1229);
    assert.equal(dayTotals(second)[kind === "work" ? "work" : "travel"], 60);
    assert.match(
      periodSummary({ ...period, start: "00:00", end: "23:59" }),
      /^23h59min/,
    );
    assert.match(
      periodSummary({ ...period, end: "24:00" }),
      /Horário inválido/,
    );
  }
});
test("equipe pode ser inteiramente de auxiliares, inclusive o primeiro contato", () => {
  const e = { technicianId: null, payload: newReport() };
  const next = withReportTeam(e as Entry, [
    { technicianId: "a", role: "auxiliary" },
    { technicianId: "b", role: "auxiliary" },
  ]);
  assert.equal(next.technicianId, "a");
  assert.equal(next.payload.primaryTechnicianRole, "auxiliary");
  assert.deepEqual(
    reportTeam(next).map((m) => m.role),
    ["auxiliary", "auxiliary"],
  );
  assert.doesNotThrow(() => validateReportTeam(next));
});
test("mesmo carro compartilha ida, volta, pausas e KM, mas não horários de trabalho", () => {
  const d = newDay("shared-car");
  d.participants = [
    {
      technicianId: "driver",
      present: true,
      odometerStart: "100",
      odometerEnd: "140",
      sameHoursAs: null,
      sameVehicleAs: null,
      periods: [
        {
          id: "out",
          kind: "outbound",
          start: "07:00",
          end: "08:00",
          pauseMinutes: "10",
        },
        {
          id: "driver-work",
          kind: "work",
          start: "08:00",
          end: "17:00",
          pauseMinutes: "60",
        },
        {
          id: "in",
          kind: "inbound",
          start: "17:00",
          end: "18:00",
          pauseMinutes: "5",
        },
      ],
    },
    {
      technicianId: "passenger",
      present: true,
      odometerStart: "",
      odometerEnd: "",
      sameHoursAs: null,
      sameVehicleAs: "driver",
      periods: [
        {
          id: "pass-out",
          kind: "outbound",
          start: "06:00",
          end: "07:00",
          pauseMinutes: "0",
        },
        {
          id: "pass-work",
          kind: "work",
          start: "09:00",
          end: "12:00",
          pauseMinutes: "15",
        },
        {
          id: "pass-in",
          kind: "inbound",
          start: "18:00",
          end: "19:00",
          pauseMinutes: "0",
        },
      ],
    },
  ];

  const passengerDay = participantDay(d, "passenger");
  assert.deepEqual(
    dayPeriods(passengerDay).map((p) => [
      p.kind,
      p.start,
      p.end,
      p.pauseMinutes,
    ]),
    [
      ["outbound", "07:00", "08:00", "10"],
      ["work", "09:00", "12:00", "15"],
      ["inbound", "17:00", "18:00", "5"],
    ],
  );
  assert.equal(passengerDay.odometerStart, "100");
  assert.equal(passengerDay.odometerEnd, "140");
  assert.equal(participantTotals(d, "passenger").km, 0);
  assert.equal(dayTotals(d).km, 40);
  assert.equal(dayTotals(d).work, 645);
  assert.equal(dayTotals(d).travel, 210);
});
test("KM por período é contado por veículo e preservado ao sair da carona", () => {
  const day = newDay("per-period-km");
  const work = {
    id: "work",
    kind: "work" as const,
    start: "08:00",
    end: "12:00",
    pauseMinutes: "15",
    odometerStart: "100",
    odometerEnd: "125",
  };
  const travel = {
    id: "trip",
    kind: "outbound" as const,
    start: "07:00",
    end: "08:00",
    pauseMinutes: "",
    odometerStart: "80",
    odometerEnd: "100",
  };
  const driver = {
    technicianId: "driver",
    present: true,
    periods: [work, travel],
    odometerStart: "1",
    odometerEnd: "90",
    sameHoursAs: null,
    sameVehicleAs: null,
  };
  const passenger = {
    ...driver,
    technicianId: "passenger",
    periods: [
      {
        ...work,
        id: "own-work",
        start: "09:00",
        odometerStart: undefined,
        odometerEnd: undefined,
      },
    ],
    sameVehicleAs: "driver",
  };
  day.participants = [driver, passenger];
  assert.equal(
    dayTotals(day).km,
    45,
    "Não duplica KM de carona nem soma o KM diário antigo",
  );
  assert.equal(
    dayPeriods(participantDay(day, "passenger")).find((p) => p.kind === "work")
      ?.start,
    "09:00",
  );
  day.participants = setDayPresence(day, "driver", false);
  assert.equal(
    dayTotals(day).km,
    45,
    "Desvincular mantém as leituras efetivas do carro",
  );
  assert.equal(dayTotals(day).work, 165);
});
test("presença diária, horas compartilhadas dinâmicas e KM por veículo", () => {
  let d = newDay("team-day");
  d.periods = [
    { id: "w", kind: "work", start: "08:00", end: "17:00", pauseMinutes: "60" },
    {
      id: "out",
      kind: "outbound",
      start: "07:00",
      end: "08:00",
      pauseMinutes: "10",
    },
  ];
  d.odometerStart = "100";
  d.odometerEnd = "125";
  const team = Array.from({ length: 5 }, (_, i) => ({
    technicianId: `t${i}`,
    role: "technician" as const,
  }));
  d.participants = dayParticipants(d, team);
  assert.equal(d.participants.length, 1); // legacy data must not mark all five as present
  assert.deepEqual(dayTotals(d), { work: 480, travel: 50, km: 25 });
  d.participants = setDayPresence(d, "t1", true);
  Object.assign(d.participants[1], { sameHoursAs: "t0", sameVehicleAs: "t0" });
  assert.deepEqual(dayTotals(d), { work: 960, travel: 100, km: 25 });
  d.participants[0].periods[0].end = "18:00";
  assert.equal(dayTotals(d).work, 1080);
  d.participants[1].periods = participantDay(d, "t1").periods!.map((p) => ({
    ...p,
  }));
  d.participants[1].sameHoursAs = null;
  d.participants[1].periods[0].end = "16:00";
  assert.equal(dayTotals(d).work, 960);
  assert.equal(dayTotals(d).km, 25); // same car, independent hours
  d.participants[1].sameHoursAs = "t0";
  Object.assign(d.participants[1], separateDayHours(d, "t1"));
  assert.equal(
    d.participants[1].periods[0].end,
    "16:00",
    "restores individual schedule when shortcut is disabled",
  );
  d.participants[1].sameVehicleAs = null;
  d.participants[1].odometerStart = "40";
  d.participants[1].odometerEnd = "50";
  assert.equal(dayTotals(d).km, 35);
  d.participants = setDayPresence(d, "t0", false);
  assert.deepEqual(dayTotals(d), { work: 420, travel: 50, km: 10 });
  d.participants = setDayPresence(d, "t0", true);
  assert.equal(d.participants[0].periods[0].end, "18:00");
});
test("retirar referência preserva horários dependentes; rejeita ciclos e pessoas fora da equipe", () => {
  const d = newDay("d");
  d.participants = [
    {
      technicianId: "a",
      present: true,
      odometerStart: "1",
      odometerEnd: "5",
      sameHoursAs: null,
      sameVehicleAs: null,
      periods: [
        {
          id: "p",
          kind: "work",
          start: "08:00",
          end: "12:00",
          pauseMinutes: "30",
        },
      ],
    },
    {
      technicianId: "b",
      present: true,
      odometerStart: "",
      odometerEnd: "",
      sameHoursAs: "a",
      sameVehicleAs: "a",
      periods: [],
    },
  ];
  const before = structuredClone(d);
  d.participants = setDayPresence(d, "a", false);
  assert.equal(d.participants[1].sameHoursAs, null);
  assert.equal(d.participants[1].sameVehicleAs, null);
  assert.equal(dayTotals(d).work, 210);
  assert.equal(dayTotals(d).km, 4);
  before.participants![0].sameHoursAs = "b";
  assert.throws(() => dayTotals(before), /circular/);
  before.participants![0].sameHoursAs = null;
  before.participants![0].present = false;
  assert.throws(() => dayTotals(before), /referência/);
  const entry = {
    technicianId: "a",
    payload: {
      ...newReport(),
      days: [d],
      additionalTechnicians: [{ technicianId: "b", role: "auxiliary" }],
    },
  };
  assert.doesNotThrow(() => validateReportTeam(entry));
  const changed = withReportTeam(entry, [
    { technicianId: "b", role: "technician" },
  ]);
  assert.doesNotThrow(() => validateReportTeam(changed));
  assert.equal(changed.payload.days[0].participants!.length, 1);
  entry.payload.additionalTechnicians = [];
  assert.throws(() => validateReportTeam(entry), /não pertence/);
});
test("interno remove deslocamentos individuais; observações e ausências sobrevivem", () => {
  const r = newReport(),
    d = newDay("notes");
  d.notes = "Trânsito intenso";
  assert.equal(hasDayData(d), true);
  d.participants = [
    {
      technicianId: "t",
      present: true,
      odometerStart: "10",
      odometerEnd: "20",
      sameHoursAs: null,
      sameVehicleAs: null,
      periods: [
        {
          id: "o",
          kind: "outbound",
          start: "07:00",
          end: "08:00",
          pauseMinutes: "5",
        },
        {
          id: "w",
          kind: "work",
          start: "08:00",
          end: "10:00",
          pauseMinutes: "10",
        },
      ],
    },
  ];
  r.days = [d];
  assert.equal(hasReportTravel(r), true);
  const internal = changeReportType(r, "interno");
  assert.equal(hasReportTravel(internal), false);
  assert.equal(internal.days[0].notes, "Trânsito intenso");
  assert.deepEqual(dayTotals(internal.days[0]), {
    work: 110,
    travel: 0,
    km: 0,
  });
});
test("múltiplos períodos descontam somente sua própria pausa dentro do mesmo dia", () => {
  const day = newDay("multi");
  day.periods = [
    {
      id: "i1",
      kind: "outbound",
      start: "06:00",
      end: "07:00",
      pauseMinutes: "10",
    },
    {
      id: "i2",
      kind: "outbound",
      start: "07:00",
      end: "07:30",
      pauseMinutes: "",
    },
    {
      id: "w1",
      kind: "work",
      start: "08:00",
      end: "17:00",
      pauseMinutes: "60",
    },
    {
      id: "w2",
      kind: "work",
      start: "17:00",
      end: "18:00",
      pauseMinutes: "15",
    },
    {
      id: "r1",
      kind: "inbound",
      start: "18:00",
      end: "19:00",
      pauseMinutes: "5",
    },
  ];
  assert.deepEqual(dayTotals(day), { work: 525, travel: 135, km: 0 });
  const r = newReport();
  r.days = [day];
  const internal = changeReportType(r, "interno");
  assert.equal(dayPeriods(internal.days[0]).length, 2);
  assert.equal(dayTotals(internal.days[0]).work, 525);
  day.periods[0].pauseMinutes = "61";
  assert.throws(() => dayTotals(day), /pausa/);
  day.periods[0].pauseMinutes = "-1";
  assert.throws(() => dayTotals(day), /pausa/);
  day.periods[0].pauseMinutes = "";
  day.periods[0].start = "24:00";
  assert.throws(() => dayTotals(day), /Horário/);
});
test("rascunho legado converte períodos e pausa sem duplicação", () => {
  const d = newDay("legacy");
  d.work = { start: "08:00", end: "09:00" };
  d.pause = { period: "work", minutes: "15" };
  assert.deepEqual(dayPeriods(d), [
    {
      id: "legacy-work",
      kind: "work",
      start: "08:00",
      end: "09:00",
      pauseMinutes: "15",
    },
  ]);
  d.periods = [];
  assert.equal(dayTotals(d).work, 0); // removal must not resurrect legacy data
});
test("dia vazio não entra no cronograma e zero é uma leitura válida", () => {
  const d = newDay("day");
  assert.equal(hasDayData(d), false);
  d.odometerStart = "0";
  assert.equal(hasDayData(d), true);
});
test("cadastro permanente exclui KM e todos os horímetros", () => {
  const raw = {
    type: "Guindaste",
    brand: "Liebherr",
    model: "LTM",
    serial: "SER-1",
    nominalCapacity: "80 t",
    year: "2020",
    plate: "N/A",
    fleet: "F1",
    odometer: "100",
    hourmeter: "200",
    hourmeterLower: "300",
    hourmeterUpper: "400",
    km: "100",
  };
  const data = permanentEquipment(raw);
  assert.deepEqual(Object.keys(data), [
    "type",
    "brand",
    "model",
    "serial",
    "nominalCapacity",
    "year",
    "plate",
    "fleet",
  ]);
  assert.doesNotThrow(() => validateEquipment(data));
  assert.throws(() => validateEquipment({ ...data, serial: "" }), /série/);
  const report = newReport();
  report.equipment = raw;
  assert.doesNotThrow(() => validateReport(report, false));
  report.equipment.hourmeterUpper = "N/A";
  assert.doesNotThrow(() => validateReport(report, false));
  report.equipment.hourmeterLower = "-1";
  assert.throws(() => validateReport(report, false), /horímetros/);
});
test("leituras inferior e superior são vinculadas ao dia, inclusive N/A e zero", () => {
  const day = newDay("meters");
  day.hourmeterLower = "0";
  day.hourmeterUpper = "N/A";
  assert.equal(hasDayData(day), true);
  assert.deepEqual(dayTotals(day), { work: 0, travel: 0, km: 0 });
  day.odometerStart = "N/A";
  day.odometerEnd = "N/A";
  assert.equal(dayTotals(day).km, 0);
  day.hourmeterUpper = "abc";
  assert.throws(() => dayTotals(day), /Leituras/);
});
test("equipe antiga é preservada e auxiliares mantêm sua função ao virar primeiro profissional", () => {
  const entry = {
    technicianId: "principal",
    payload: { ...newReport(), auxiliaries: ["aux", "principal", "aux"] },
  };
  assert.deepEqual(reportTeam(entry), [
    { technicianId: "principal", role: "technician" },
    { technicianId: "aux", role: "auxiliary" },
  ]);
  const promoted = withReportTeam(entry, reportTeam(entry).slice(1));
  assert.equal(promoted.technicianId, "aux");
  assert.deepEqual(reportTeam(promoted), [
    { technicianId: "aux", role: "auxiliary" },
  ]);
  assert.deepEqual(promoted.payload.auxiliaries, []);
});
test("equipe permite vários técnicos e auxiliares, sem limite fixo de linhas", () => {
  const members = Array.from({ length: 120 }, (_, i) => ({
    technicianId: `t${i}`,
    role: i % 2 ? ("auxiliary" as const) : ("technician" as const),
  }));
  const entry = withReportTeam(
    { technicianId: null as string | null, payload: newReport() },
    members,
  );
  assert.deepEqual(reportTeam(entry), members);
  assert.equal(entry.payload.auxiliaries.length, 60);
  assert.doesNotThrow(() => validateReportTeam(entry));
});
test("equipe rejeita profissional repetido e linha adicional não preenchida", () => {
  const entry = { technicianId: "t1", payload: newReport() };
  assert.throws(
    () =>
      validateReportTeam(
        withReportTeam(entry, [
          { technicianId: "t1", role: "technician" },
          { technicianId: "t1", role: "auxiliary" },
        ]),
      ),
    /mais de uma vez/,
  );
  assert.throws(
    () =>
      validateReportTeam(
        withReportTeam(entry, [
          { technicianId: "t1", role: "technician" },
          { technicianId: "", role: "technician" },
        ]),
      ),
    /linhas vazias/,
  );
  assert.doesNotThrow(() =>
    validateReportTeam({ technicianId: null, payload: newReport() }),
  );
});
test("horário legado também exige divisão por dia e pausa no período selecionado", () => {
  const d = newDay("day");
  d.work = { start: "22:00", end: "02:00" };
  d.outbound = { start: "20:00", end: "21:00" };
  d.pause = { period: "outbound", minutes: "15" };
  assert.throws(() => dayTotals(d), /outro dia/);
  d.work.end = "23:59";
  assert.deepEqual(dayTotals(d), { work: 119, travel: 45, km: 0 });
  d.pause.minutes = "61";
  assert.throws(() => dayTotals(d), /pausa/);
});
test("KM final menor que inicial e quantidade inválida são rejeitados", () => {
  const d = newDay("d");
  d.odometerStart = "10";
  d.odometerEnd = "9";
  assert.throws(() => dayTotals(d), /leitura/);
  const r = newReport();
  r.parts = [
    {
      id: "p",
      code: "x",
      description: "",
      supplier: "",
      quantity: 0,
      kind: "requested",
      codeHistory: [],
    },
  ];
  assert.throws(() => validateReport(r, false), /quantidade/);
});
test("normalização garante identidade com máscara ou sem máscara", () => {
  assert.equal(
    canonicalDocument("clients", "12.345.678/0001-95"),
    "12345678000195",
  );
  assert.equal(
    canonicalDocument("technicians", "123.456.789-09"),
    "12345678909",
  );
  assert.equal(canonicalDocument("parts", " ab-01 "), "AB-01");
});

test("edição do mesmo cliente preserva equipamento; troca limpa somente vínculos e dados relacionados", () => {
  const entry = {
    clientId: "client",
    equipmentId: "eq",
    kind: "reports",
    payload: { ...newReport(), equipment: { serial: "ABC", odometer: "10" } },
  } as Entry;
  assert.equal(changeEntryClient(entry, "client"), entry);
  const changed = changeEntryClient(entry, "other");
  assert.equal(changed.equipmentId, null);
  assert.deepEqual(changed.payload.equipment, {});
  const inspection = {
    ...entry,
    kind: "inspections" as const,
    payload: {
      documentFields: {
        "002": "Modelo",
        "006": "10",
        "009": "Técnico",
        "010": "09/10/2026",
      },
      sections: [],
    },
  };
  assert.equal(changeEntryClient(inspection, "client"), inspection);
  const next = changeEntryClient(inspection, "other");
  assert.equal(next.payload.documentFields["002"], "");
  assert.equal(next.payload.documentFields["006"], "");
  assert.equal(next.payload.documentFields["009"], "Técnico");
  assert.equal(next.payload.documentFields["010"], "09/10/2026");
});

test("rascunho parcial permitido; finalização exige equipamento e serviços em cada motivo", () => {
  const r = newReport();
  assert.doesNotThrow(() => validateReport(r, false));
  assert.throws(() => validateReport(r, true), /equipamento/);
  r.equipment = {
    type: "Guindaste",
    brand: "Marca",
    model: "Modelo",
    serial: "Série",
  };
  r.reasons = [{ id: "r", description: "Motivo", services: [], pending: "" }];
  r.concluded = r.released = r.photosSent = "Sim";
  r.technicianSignature = r.clientSignature = {
    uri: "/api/media/signature",
    name: "assinatura",
  };
  assert.throws(() => validateReport(r, true), /serviço em cada motivo/);
  r.reasons[0].services = [
    { id: "s", description: "Serviço", notes: "", photos: [] },
  ];
  assert.doesNotThrow(() => validateReport(r, true));
  r.reasons[0].services[0].description = " ";
  assert.throws(() => validateReport(r, true), /serviços vazios/);
});

test("interno usa trabalho e pausa; mudança explícita preserva leituras do equipamento e não muta o original", () => {
  const r = newReport();
  const day = newDay("day");
  r.days = [day];
  day.work = { start: "08:00", end: "17:00" };
  day.outbound = { start: "07:00", end: "08:00" };
  day.odometerStart = "100";
  day.odometerEnd = "120";
  day.hourmeterLower = "55";
  day.pause = { period: "work", minutes: "60" };
  r.equipment = { odometer: "500" };
  assert.equal(hasReportTravel(r), true);
  const internal = changeReportType(r, "interno");
  assert.equal(hasReportTravel(internal), false);
  assert.deepEqual(dayTotals(internal.days[0]), {
    work: 480,
    travel: 0,
    km: 0,
  });
  assert.equal(internal.days[0].hourmeterLower, "55");
  assert.equal(internal.equipment.odometer, "500");
  assert.equal(r.days[0].odometerEnd, "120");
  assert.throws(
    () => validateReport({ ...r, type: "interno" }, true),
    /interno/,
  );
});
