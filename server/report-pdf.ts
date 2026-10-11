import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  dayTotals,
  participantTotals,
  participantDay,
  dayPeriods,
  periodLabels,
  hasDayData,
  hasPeriodData,
  type Entry,
  type Report,
  type Media,
} from "../contracts/domain.js";

const NAVY = "#18181b";
const GOLD = "#c9a84c";
const MARGIN = 42;
const PAGE_BOTTOM = 778;

/** BR LIFT's version of the V0 report: same hierarchy, A4 cadence and gold/navy
 * visual language, with the current normalized report fields and per-person day data. */
export async function createReportPdf(
  record: Entry,
  storage: string,
): Promise<Buffer> {
  const data = record.payload as Report;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 52, bottom: 42, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `Relatório de atendimento — ${record.number}`,
      Author: "BR LIFT",
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - MARGIN * 2;
  const people = record.payload.teamSnapshot ?? [];
  const personName = (id: string) =>
    people.find((p: { technicianId: string }) => p.technicianId === id)?.name ??
    id;
  const date = (value: string) => {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00`)
      : new Date(value);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleDateString("pt-BR");
  };
  const clean = (value: unknown) => String(value ?? "").trim() || "—";
  const minutesAsHours = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  function pageHeader(first = false) {
    const y = first ? 0 : 0;
    doc.rect(0, y, doc.page.width, first ? 29 : 17).fill(NAVY);
    if (first) {
      doc.rect(0, 29, doc.page.width, 2).fill(GOLD);
      doc
        .font("Helvetica-Bold")
        .fontSize(19)
        .fillColor(GOLD)
        .text("BR", MARGIN, 8, { lineBreak: false });
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#ffffff")
        .text("LIFT", MARGIN + 28, 11, { lineBreak: false });
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#ffffff")
        .text("RELATÓRIO DE ATENDIMENTO TÉCNICO", MARGIN + 66, 8, {
          lineBreak: false,
        });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(GOLD)
        .text(`Nº ${record.number}`, doc.page.width - MARGIN - 112, 20, {
          width: 112,
          align: "right",
          lineBreak: false,
        });
    } else {
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(GOLD)
        .text("BR LIFT", MARGIN, 6, { lineBreak: false });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#ffffff")
        .text(`Atendimento ${record.number}`, MARGIN + 60, 6, {
          lineBreak: false,
        });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#ffffff")
        .text("continuação", doc.page.width - MARGIN - 72, 6, {
          width: 72,
          align: "right",
          lineBreak: false,
        });
    }
  }
  function footer(page: number, total: number) {
    const y = doc.page.height - 60;
    doc
      .strokeColor(GOLD)
      .lineWidth(0.6)
      .moveTo(MARGIN, y)
      .lineTo(doc.page.width - MARGIN, y)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#777777")
      .text(`BR LIFT • Atendimento ${record.number}`, MARGIN, y + 5, {
        lineBreak: false,
      });
    doc.text(`Pág. ${page}/${total}`, doc.page.width - MARGIN - 48, y + 5, {
      width: 48,
      align: "right",
      lineBreak: false,
    });
  }
  function nextPage() {
    doc.addPage();
    pageHeader();
    doc.y = 29;
  }
  function ensure(height: number) {
    if (doc.y + height > PAGE_BOTTOM) nextPage();
  }
  function section(index: string, title: string) {
    ensure(32);
    doc.moveDown(0.5);
    const y = doc.y;
    doc.rect(MARGIN, y, width, 21).fill(NAVY);
    doc.rect(MARGIN, y, 4, 21).fill(GOLD);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(GOLD)
      .text(index, MARGIN + 11, y + 7, { lineBreak: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#ffffff")
      .text(title.toUpperCase(), MARGIN + 38, y + 6, { lineBreak: false });
    doc.y = y + 27;
  }
  function textBlock(
    value: unknown,
    opts: {
      x?: number;
      width?: number;
      bold?: boolean;
      size?: number;
      color?: string;
      gap?: number;
    } = {},
  ) {
    const content = clean(value);
    const x = opts.x ?? MARGIN + 9;
    const w = opts.width ?? width - 18;
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.size ?? 9);
    const h = doc.heightOfString(content, { width: w, lineGap: 1 });
    ensure(h + 12);
    const y = doc.y;
    if (opts.bold) doc.rect(MARGIN, y - 1, 3, Math.max(14, h + 2)).fill(GOLD);
    doc
      .fillColor(opts.color ?? "#222222")
      .text(content, x, y, { width: w, lineGap: 1 });
    doc.y = y + h + (opts.gap ?? 5);
  }
  function pairGrid(pairs: Array<[string, unknown]>) {
    const colW = (width - 12) / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const row = pairs.slice(i, i + 2);
      const heights = row.map(([, value]) => {
        doc.font("Helvetica").fontSize(9);
        return doc.heightOfString(clean(value), {
          width: colW - 8,
          lineGap: 1,
        });
      });
      const h = Math.max(heights[0] ?? 0, heights[1] ?? 0) + 16;
      ensure(h);
      const y = doc.y;
      row.forEach(([label, value], j) => {
        const x = MARGIN + j * (colW + 12);
        doc
          .font("Helvetica-Bold")
          .fontSize(6.5)
          .fillColor("#777777")
          .text(label.toUpperCase(), x, y, { width: colW - 8 });
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#222222")
          .text(clean(value), x, y + 8, { width: colW - 8, lineGap: 1 });
      });
      doc.y = y + h;
    }
  }
  function listItem(index: number, title: unknown, detail?: unknown) {
    const content = [
      clean(title),
      detail && String(detail).trim() ? String(detail).trim() : "",
    ]
      .filter(Boolean)
      .join("\n");
    doc.font("Helvetica").fontSize(9);
    const h = doc.heightOfString(content, { width: width - 40, lineGap: 1 });
    ensure(h + 9);
    const y = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(GOLD)
      .text(String(index).padStart(2, "0"), MARGIN, y, { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#222222")
      .text(content, MARGIN + 27, y, { width: width - 27, lineGap: 1 });
    doc.y = y + h + 7;
  }
  async function image(
    media: Media | undefined,
    box: { width: number; height: number },
  ) {
    if (!media?.uri) return;
    const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(media.uri);
    if (!match) return;
    const bytes = await fs.readFile(path.join(storage, "media", match[1]));
    ensure(box.height + 24);
    const y = doc.y;
    doc.image(bytes, MARGIN + 9, y + 12, {
      fit: [box.width, box.height],
      align: "center",
      valign: "center",
    });
    doc.y = y + box.height + 18;
  }

  pageHeader(true);
  doc.y = 43;
  pairGrid([
    ["Emissão", date(new Date().toISOString())],
    ["Identificador", record.number],
    ["Status", record.status === "draft" ? "Rascunho" : "Finalizado"],
  ]);
  if (record.status === "draft")
    textBlock("RASCUNHO — documento ainda não finalizado", {
      bold: true,
      color: "#a33520",
    });

  section("A", "Identificação");
  pairGrid([
    ["Data do atendimento", date(record.date)],
    ["Cliente", record.payload.clientSnapshot?.name],
    ["CNPJ / CPF", record.payload.clientSnapshot?.identifier],
    ["Tipo de atendimento", data.type],
    ["Operador", data.operator],
    ["Solicitante", data.requester],
    ["Local", data.location],
  ]);
  for (const [i, person] of (record.payload.teamSnapshot ?? []).entries())
    pairGrid([
      [
        i === 0
          ? "Técnico responsável"
          : person.role === "auxiliary"
            ? "Auxiliar"
            : "Técnico",
        person.name,
      ],
      ["Documento", person.identifier],
    ]);
  if (!record.payload.teamSnapshot?.length)
    pairGrid([
      ["Técnico responsável", record.payload.technicianSnapshot?.name],
      ["Documento", record.payload.technicianSnapshot?.identifier],
      [
        "Técnicos auxiliares",
        record.payload.auxiliaryNames?.join(", ") ||
          data.auxiliaries.join(", "),
      ],
    ]);

  section("B", "Equipamento");
  pairGrid([
    ["Tipo", data.equipment.type],
    ["Marca", data.equipment.brand],
    ["Modelo", data.equipment.model],
    ["Série / chassi", data.equipment.serial],
    ["Ano de fabricação", data.equipment.year],
    ["Placa", data.equipment.plate],
    ["Frota", data.equipment.fleet],
    ["KM na data", data.equipment.odometer],
    [
      "Horímetro inferior",
      data.equipment.hourmeterLower ?? data.equipment.hourmeter,
    ],
    ["Horímetro superior", data.equipment.hourmeterUpper],
  ]);

  section("C", "Motivo do serviço");
  if (!data.reasons.length)
    textBlock("Nenhum motivo informado.", { color: "#777777" });
  for (const [ri, reason] of data.reasons.entries())
    listItem(ri + 1, reason.description);

  section("D", "Serviços realizados");
  let serviceCount = 0;
  for (const reason of data.reasons) {
    for (const [si, service] of reason.services.entries()) {
      serviceCount++;
      listItem(
        serviceCount,
        service.description,
        [reason.description, service.notes].filter(Boolean).join("\n"),
      );
      for (const photo of service.photos) {
        textBlock(photo.name, { bold: true, size: 7 });
        await image(photo, { width: 235, height: 155 });
      }
    }
  }
  if (!serviceCount)
    textBlock("Nenhum serviço informado.", { color: "#777777" });

  section("E", "Peças utilizadas / solicitadas");
  if (!data.parts.length)
    textBlock("Nenhuma peça registrada.", { color: "#777777" });
  for (const [i, part] of data.parts.entries())
    listItem(
      i + 1,
      part.description || part.code,
      `Código: ${part.code || "—"}  •  Fornecedor: ${part.supplier || "—"}  •  Quantidade: ${part.quantity}  •  ${part.kind === "replaced" ? "Substituída" : "Solicitada"}`,
    );

  section("F", "Pendências / próximos passos");
  const pending = data.reasons
    .map((reason) => reason.pending?.trim())
    .filter(Boolean);
  if (!pending.length)
    textBlock("Nenhuma pendência registrada.", { color: "#777777" });
  for (const [i, item] of pending.entries()) listItem(i + 1, item);

  section("G", "Cronograma de atendimento");
  const days = data.days.filter(hasDayData);
  if (!days.length)
    textBlock("Nenhum dia de atendimento registrado.", { color: "#777777" });
  for (const [di, day] of days.entries()) {
    ensure(28);
    const y = doc.y;
    doc.rect(MARGIN, y, width, 19).fill("#f4f1e8");
    doc.rect(MARGIN, y, 3, 19).fill(GOLD);
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(NAVY)
      .text(
        `DIA ${String(di + 1).padStart(2, "0")}  ·  ${date(day.date)}`,
        MARGIN + 9,
        y + 6,
        { lineBreak: false },
      );
    doc.y = y + 25;
    if (day.notes?.trim())
      textBlock(`Observações do dia: ${day.notes}`, {
        bold: true,
        color: "#454545",
      });
    const crew =
      day.participants === undefined
        ? [
            {
              technicianId: record.technicianId ?? "",
              present: true,
              sameHoursAs: null,
              sameVehicleAs: null,
            },
          ]
        : day.participants.filter((p) => p.present);
    for (const person of crew) {
      const schedule =
        day.participants === undefined
          ? day
          : participantDay(day, person.technicianId);
      textBlock(
        day.participants === undefined
          ? "Horários registrados"
          : personName(person.technicianId),
        { bold: true, size: 9, gap: 3 },
      );
      if (person.sameHoursAs)
        textBlock(`Mesmo horário de ${personName(person.sameHoursAs)}`, {
          size: 8,
          color: "#666666",
          gap: 3,
        });
      if (person.sameVehicleAs)
        textBlock(
          `Mesmo carro de ${personName(person.sameVehicleAs)} — KM e deslocamentos compartilhados`,
          { size: 8, color: "#666666", gap: 3 },
        );
      const ownTotals =
        day.participants === undefined
          ? dayTotals(schedule)
          : participantTotals(day, person.technicianId);
      pairGrid([
        [
          "KM inicial / final",
          `${clean(schedule.odometerStart)} / ${clean(schedule.odometerEnd)}`,
        ],
        [
          "KM atribuído",
          ownTotals.km
            ? `${ownTotals.km} km`
            : person.sameVehicleAs
              ? "Compartilhado (não duplicado)"
              : "—",
        ],
      ]);
      for (const kind of ["outbound", "work", "inbound"] as const) {
        const periods = dayPeriods(schedule).filter(
          (p) => p.kind === kind && hasPeriodData(p),
        );
        for (const [pi, period] of periods.entries())
          pairGrid([
            [
              `${periodLabels[kind]} ${pi + 1}`,
              `${period.start || "—"} às ${period.end || "—"}`,
            ],
            ["Pausa", `${period.pauseMinutes || "0"} min`],
          ]);
      }
      pairGrid([
        ["Trabalho", `${ownTotals.work} min`],
        ["Deslocamento", `${ownTotals.travel} min`],
      ]);
    }
    if (day.participants !== undefined) {
      const totals = dayTotals(day);
      textBlock(
        `Total do dia (KM sem duplicidade): ${totals.km} km  •  Trabalho da equipe: ${totals.work} min  •  Deslocamento da equipe: ${totals.travel} min`,
        { bold: true, size: 8, color: NAVY },
      );
    }
  }
  const total = days.reduce(
    (sum, day) => {
      const current = dayTotals(day);
      return {
        work: sum.work + current.work,
        travel: sum.travel + current.travel,
        km: sum.km + current.km,
      };
    },
    { work: 0, travel: 0, km: 0 },
  );
  ensure(42);
  const summaryY = doc.y;
  doc.rect(MARGIN, summaryY, width, 23).fill("#f4f1e8");
  doc.rect(MARGIN, summaryY, 4, 23).fill(GOLD);
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(NAVY)
    .text("RESUMO DE HORAS E DESLOCAMENTO", MARGIN + 11, summaryY + 4, {
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#333333")
    .text(
      `Trabalho ${minutesAsHours(total.work)}  •  Deslocamento ${minutesAsHours(total.travel)}  •  KM ${total.km}`,
      MARGIN + 11,
      summaryY + 13,
      { lineBreak: false },
    );
  doc.y = summaryY + 30;

  section("H", "Status final");
  pairGrid([
    ["Atendimento concluído", data.concluded],
    ["Equipamento liberado", data.released],
    ["Fotos enviadas", data.photosSent],
  ]);
  textBlock(data.observations, { bold: true });
  ensure(108);
  const signatureY = doc.y;
  const signatureGap = 10;
  const signatureWidth = (width - signatureGap) / 2;
  const signatures: Array<[string, Media | undefined]> = [
    ["Assinatura do técnico", data.technicianSignature],
    ["Assinatura do cliente", data.clientSignature],
  ];
  for (const [index, [label, signature]] of signatures.entries()) {
    const x = MARGIN + index * (signatureWidth + signatureGap);
    doc
      .roundedRect(x, signatureY, signatureWidth, 88, 3)
      .lineWidth(0.6)
      .stroke(GOLD);
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(NAVY)
      .text(label.toUpperCase(), x + 8, signatureY + 7, {
        width: signatureWidth - 16,
        align: "center",
        lineBreak: false,
      });
    const match = signature?.uri.match(/^\/api\/media\/([a-f0-9-]{36})$/);
    if (match) {
      const bytes = await fs.readFile(path.join(storage, "media", match[1]));
      doc.image(bytes, x + 12, signatureY + 18, {
        fit: [signatureWidth - 24, 50],
        align: "center",
        valign: "center",
      });
    } else {
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor("#888888")
        .text("Não informada", x + 8, signatureY + 42, {
          width: signatureWidth - 16,
          align: "center",
          lineBreak: false,
        });
    }
    doc
      .moveTo(x + 12, signatureY + 72)
      .lineTo(x + signatureWidth - 12, signatureY + 72)
      .strokeColor("#999999")
      .lineWidth(0.4)
      .stroke();
  }
  doc.y = signatureY + 96;

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    if (i > 0) pageHeader();
    footer(i + 1, range.count);
  }
  doc.end();
  return finished;
}
