import PDFDocument from "pdfkit";
import sharp from "sharp";
import { mediaStorageKey } from "./object-storage/index.js";
import type { ObjectStorage } from "./object-storage/types.js";
import {
  dayTotals,
  participantTotals,
  participantDay,
  dayPeriods,
  periodLabels,
  hasDayData,
  hasPeriodData,
  reportTypeLabels,
  signatureDateTime,
  type Entry,
  type Report,
  type Media,
} from "../contracts/domain.js";

const NAVY = "#18181b";
const GOLD = "#c9a84c";
const MARGIN = 42;
const BODY_TOP = 48;
const FOOTER_RESERVE = 90;

/** BR LIFT's version of the V0 report: same hierarchy, A4 cadence and gold/navy
 * visual language, with the current normalized report fields and per-person day data. */
export async function createReportPdf(
  record: Entry,
  storage: ObjectStorage,
): Promise<Buffer> {
  const data = record.payload as Report;
  const doc = new PDFDocument({
    size: "A4",
    margins: {
      top: BODY_TOP,
      bottom: FOOTER_RESERVE,
      left: MARGIN,
      right: MARGIN,
    },
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
      : parsed.toLocaleDateString("pt-BR", {
          weekday: "long",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
  };
  const clean = (value: unknown) => String(value ?? "").trim() || "—";
  const minutesAsHours = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  function pageHeader(first = false) {
    doc.rect(0, 0, doc.page.width, first ? 60 : 28).fill(NAVY);
    doc.rect(0, first ? 60 : 28, doc.page.width, 2).fill(GOLD);
    if (first) {
      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .fillColor(GOLD)
        .text("BR LIFT", MARGIN, 13, { lineBreak: false });
      doc
        .font("Helvetica-Bold")
        .fontSize(10.5)
        .fillColor("#ffffff")
        .text("RELATÓRIO DE ATENDIMENTO TÉCNICO", MARGIN + 96, 15, {
          lineBreak: false,
        });
      doc.font("Helvetica-Bold").fontSize(13).fillColor(GOLD);
      const order = `O.S. OMIE ${record.number}`;
      const orderWidth = doc.widthOfString(order);
      if (orderWidth > width) doc.fontSize((13 * width) / orderWidth);
      doc.text(order, MARGIN, 37, {
        width,
        align: "right",
        lineBreak: false,
      });
    } else {
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(GOLD)
        .text("BR LIFT", MARGIN, 10, { lineBreak: false });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#ffffff")
        .text(`Atendimento ${record.number}`, MARGIN + 60, 10, {
          lineBreak: false,
        });
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#ffffff")
        .text("continuação", doc.page.width - MARGIN - 72, 10, {
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
  }
  function ensure(height: number) {
    const bottom = doc.page.height - FOOTER_RESERVE;
    const capacity = bottom - BODY_TOP;
    // Oversized paragraphs flow through PDFKit's normal page margins. Do not
    // reset the cursor to their original page after that automatic pagination.
    if (
      (height <= capacity && doc.y + height > bottom) ||
      (height > capacity && bottom - doc.y < 60)
    )
      nextPage();
  }
  let sectionNumber = 0;
  function section(title: string, firstContent = 80) {
    const index = String.fromCharCode(65 + sectionNumber++);
    ensure(46 + firstContent);
    const y = doc.y + 10;
    doc.rect(MARGIN, y, width, 26).fill(NAVY);
    doc.rect(MARGIN, y, 4, 26).fill(GOLD);
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(GOLD)
      .text(index, MARGIN + 11, y + 9, { lineBreak: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#ffffff")
      .text(title.toUpperCase(), MARGIN + 34, y + 8, { lineBreak: false });
    doc.y = y + 36;
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
      .fontSize(opts.size ?? 9.5);
    const h = doc.heightOfString(content, { width: w, lineGap: 2 });
    ensure(Math.min(h + 12, 80));
    const y = doc.y;
    if (opts.bold)
      doc
        .rect(
          MARGIN,
          y,
          2,
          Math.min(Math.max(14, h), doc.page.height - FOOTER_RESERVE - y),
        )
        .fill(GOLD);
    doc
      .fillColor(opts.color ?? "#222222")
      .text(content, x, y, { width: w, lineGap: 2 });
    doc.y += opts.gap ?? 8;
  }
  function pairGrid(pairs: Array<[string, unknown]>) {
    const colW = (width - 14) / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const row = pairs.slice(i, i + 2);
      const labelHeights = row.map(([label]) => {
        doc.font("Helvetica-Bold").fontSize(7.5);
        return doc.heightOfString(label.toUpperCase(), { width: colW - 16 });
      });
      const heights = row.map(([, value], index) => {
        doc.font("Helvetica").fontSize(9.5);
        return (
          labelHeights[index] +
          4 +
          doc.heightOfString(clean(value), {
            width: colW - 16,
            lineGap: 2,
          }) +
          18
        );
      });
      const h = Math.max(...heights);
      if (h > doc.page.height - FOOTER_RESERVE - BODY_TOP) {
        for (const [label, value] of row) {
          doc.font("Helvetica").fontSize(9.5);
          const valueHeight = doc.heightOfString(clean(value), {
            width: width - 18,
            lineGap: 2,
          });
          ensure(
            valueHeight + 30 <= doc.page.height - FOOTER_RESERVE - BODY_TOP
              ? valueHeight + 30
              : 80,
          );
          textBlock(label.toUpperCase(), { bold: true, size: 7.5, gap: 4 });
          textBlock(value);
        }
        continue;
      }
      ensure(h);
      const y = doc.y;
      row.forEach(([label, value], j) => {
        const x = MARGIN + j * (colW + 14);
        doc
          .font("Helvetica-Bold")
          .fontSize(7.5)
          .fillColor("#666666")
          .text(label.toUpperCase(), x + 8, y + 6, { width: colW - 16 });
        doc
          .font("Helvetica")
          .fontSize(9.5)
          .fillColor("#222222")
          .text(clean(value), x + 8, y + 10 + labelHeights[j], {
            width: colW - 16,
            lineGap: 2,
          });
        doc
          .strokeColor("#e4e4e7")
          .lineWidth(0.4)
          .moveTo(x, y + h - 3)
          .lineTo(x + colW, y + h - 3)
          .stroke();
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
    doc.font("Helvetica").fontSize(9.5);
    const h = doc.heightOfString(content, { width: width - 34, lineGap: 2 });
    ensure(Math.min(h + 12, 80));
    const y = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(GOLD)
      .text(String(index).padStart(2, "0"), MARGIN, y, { lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor("#222222")
      .text(content, MARGIN + 34, y, { width: width - 34, lineGap: 2 });
    doc.y += 10;
  }
  async function image(
    media: Media | undefined,
    box: { width: number; height: number },
  ) {
    if (!media?.uri) return;
    const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(media.uri);
    if (!match) return;
    const bytes = await storage.read(mediaStorageKey(match[1]));
    const dimensions = await sharp(bytes, {
      limitInputPixels: 40000000,
    }).metadata();
    const scale = Math.min(
      box.width / dimensions.width!,
      box.height / dimensions.height!,
    );
    const imageWidth = dimensions.width! * scale;
    const imageHeight = dimensions.height! * scale;
    ensure(imageHeight + 28);
    const y = doc.y;
    doc.image(bytes, MARGIN + (width - imageWidth) / 2, y + 12, {
      width: imageWidth,
      height: imageHeight,
    });
    doc.y = y + imageHeight + 28;
  }

  doc.y = 76;
  if (record.status === "draft")
    textBlock("RASCUNHO — documento ainda não finalizado", {
      bold: true,
      color: "#a33520",
    });

  section("Identificação");
  const vehicle = record.payload.vehicleSnapshot;
  pairGrid([
    ["Cliente", record.payload.clientSnapshot?.name || record.clientName],
    ["CNPJ / CPF", record.payload.clientSnapshot?.identifier],
    ["Tipo de atendimento", reportTypeLabels[data.type] || data.type],
    ["Solicitante", data.requester],
    ["Local", data.location],
    ...(vehicle
      ? [
          [
            "Veículo",
            [vehicle.plate, vehicle.model, vehicle.color, vehicle.rentalCompany]
              .filter(Boolean)
              .join(" · "),
          ] as [string, string],
        ]
      : []),
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
      ...(person.charged
        ? [["Serviço cobrado", person.charged] as [string, string]]
        : []),
    ]);
  if (!record.payload.teamSnapshot?.length)
    pairGrid([
      ["Técnico responsável", record.payload.technicianSnapshot?.name],
      [
        "Técnicos auxiliares",
        record.payload.auxiliaryNames?.join(", ") ||
          data.auxiliaries.join(", "),
      ],
    ]);

  section("Equipamento");
  pairGrid([
    ["Tipo", data.equipment.type],
    ["Marca", data.equipment.brand],
    ["Modelo", data.equipment.model],
    ["Série / chassi", data.equipment.serial],
    ["Ano de fabricação", data.equipment.year],
    ["Placa", data.equipment.plate],
    ["Frota", data.equipment.fleet],
    ["Operador", data.operator],
    ["KM", data.equipment.odometer],
    [
      "Hor. Inferior",
      data.equipment.hourmeterLower ?? data.equipment.hourmeter,
    ],
    ["Hor. Superior", data.equipment.hourmeterUpper],
  ]);

  const reasonLeadHeight = (reason: Report["reasons"][number]) => {
    doc.font("Helvetica").fontSize(9.5);
    const reasonHeight = doc.heightOfString(clean(reason.description), {
      width: width - 34,
      lineGap: 2,
    });
    const firstService = reason.services[0];
    const serviceHeight = firstService
      ? doc.heightOfString(
          `Serviço realizado: ${clean(firstService.description)}`,
          { width: width - 18, lineGap: 2 },
        )
      : 0;
    return Math.min(reasonHeight, 45) + Math.min(serviceHeight, 40) + 24;
  };
  section(
    "Motivos e serviços",
    data.reasons[0] ? reasonLeadHeight(data.reasons[0]) : 36,
  );
  if (!data.reasons.length)
    textBlock("Nenhum motivo informado.", { color: "#777777" });
  for (const [ri, reason] of data.reasons.entries()) {
    ensure(reasonLeadHeight(reason));
    listItem(ri + 1, reason.description);
    for (const [si, service] of reason.services.entries()) {
      ensure(60);
      textBlock(
        `${reason.services.length > 1 ? "Serviço " + (si + 1) : "Serviço realizado"}: ${clean(service.description)}`,
      );
      if (service.completed)
        textBlock(`Serviço concluído: ${service.completed}`);
      if (service.notes) textBlock(`Observações: ${service.notes}`);
      for (const photo of service.photos) {
        await image(photo, { width: 360, height: 240 });
      }
    }
  }

  section("Peças utilizadas / solicitadas");
  if (!data.parts.length)
    textBlock("Nenhuma peça registrada.", { color: "#777777" });
  for (const [i, part] of data.parts.entries())
    listItem(
      i + 1,
      part.description || part.code,
      `Código: ${part.code || "—"}  •  Fornecedor: ${part.supplier || "—"}  •  Quantidade: ${part.quantity}  •  Tipo de serviço: ${part.kind === "replaced" ? "Substituída" : "Solicitada"}`,
    );

  section("Pendências / próximos passos");
  const pending = data.reasons
    .map((reason) => reason.pending?.trim())
    .filter(Boolean);
  if (!pending.length)
    textBlock("Nenhuma pendência registrada.", { color: "#777777" });
  for (const [i, item] of pending.entries()) listItem(i + 1, item);

  const days = data.days.filter(hasDayData);
  section("Cronograma de atendimento", days.length ? 150 : 80);
  if (!days.length)
    textBlock("Nenhum dia de atendimento registrado.", { color: "#777777" });
  for (const [di, day] of days.entries()) {
    ensure(140);
    const y = doc.y;
    doc.rect(MARGIN, y, width, 26).fill("#f4f1e8");
    doc.rect(MARGIN, y, 3, 26).fill(GOLD);
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(NAVY)
      .text(
        `DIA ${String(di + 1).padStart(2, "0")}  ·  ${date(day.date)}`,
        MARGIN + 9,
        y + 8,
        { lineBreak: false },
      );
    doc.y = y + 36;
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
      ensure(75);
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
        ...(schedule.odometerStart || schedule.odometerEnd
          ? [
              [
                "KM histórico do dia (inicial / final)",
                `${clean(schedule.odometerStart)} / ${clean(schedule.odometerEnd)}`,
              ] as [string, string],
            ]
          : []),
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
        for (const [pi, period] of periods.entries()) {
          ensure(96);
          pairGrid([
            [
              `${periodLabels[kind]} ${pi + 1}`,
              `${period.start || "—"} às ${period.end || "—"}`,
            ],
            ["Pausa", `${period.pauseMinutes || "0"} min`],
            ...(data.formRevision === 2 ||
            period.odometerStart ||
            period.odometerEnd
              ? ([
                  ["KM inicial", period.odometerStart],
                  ["KM final", period.odometerEnd],
                ] as [string, unknown][])
              : []),
          ]);
        }
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
  const summaryText = `Trabalho ${minutesAsHours(total.work)}  •  Deslocamento ${minutesAsHours(total.travel)}  •  KM ${total.km}`;
  doc.font("Helvetica").fontSize(9);
  const summaryHeight =
    24 + doc.heightOfString(summaryText, { width: width - 24, lineGap: 2 }) + 8;
  ensure(summaryHeight + 12);
  const summaryY = doc.y;
  doc.rect(MARGIN, summaryY, width, summaryHeight).fill("#f4f1e8");
  doc.rect(MARGIN, summaryY, 4, summaryHeight).fill(GOLD);
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(NAVY)
    .text("RESUMO DE HORAS E DESLOCAMENTO", MARGIN + 12, summaryY + 8, {
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#333333")
    .text(summaryText, MARGIN + 12, summaryY + 24, {
      width: width - 24,
      lineGap: 2,
    });
  doc.y = summaryY + summaryHeight + 12;

  section("Status final");
  pairGrid([
    ["Atendimento concluído", data.concluded],
    ["Equipamento liberado", data.released],
    [
      "Status do documento",
      record.status === "finalized" ? "Finalizado" : "Rascunho",
    ],
  ]);
  if (data.observations?.trim()) textBlock(data.observations, { bold: true });
  const signatureGap = 16;
  const signatureWidth = (width - signatureGap) / 2;
  const signatures: Array<[string, Media | undefined, string, string]> = [
    [
      "Assinatura do técnico",
      data.technicianSignature,
      record.payload.technicianSnapshot?.name || record.technicianName || "",
      "Técnico",
    ],
    [
      "Assinatura do cliente",
      data.clientSignature,
      data.requester ||
        record.payload.clientSnapshot?.name ||
        record.clientName ||
        "",
      "Representante do cliente",
    ],
  ];
  const captions = signatures.map(([, signature, name, role]) =>
    signature
      ? [
          signature.signerName || name || "Nome não registrado",
          role,
          signatureDateTime(signature.createdAt),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
  );
  doc.font("Helvetica").fontSize(8.5);
  const signatureHeight = Math.max(
    124,
    ...captions.map(
      (caption) =>
        105 +
        doc.heightOfString(caption, { width: signatureWidth - 24, lineGap: 2 }),
    ),
  );
  ensure(signatureHeight + 20);
  const signatureY = doc.y + 10;
  for (const [index, [label, signature]] of signatures.entries()) {
    const x = MARGIN + index * (signatureWidth + signatureGap);
    doc
      .roundedRect(x, signatureY, signatureWidth, signatureHeight, 3)
      .lineWidth(0.6)
      .stroke("#d4d4d8");
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(NAVY)
      .text(label.toUpperCase(), x + 12, signatureY + 12, {
        width: signatureWidth - 16,
        align: "center",
        lineBreak: false,
      });
    const match = signature?.uri.match(/^\/api\/media\/([a-f0-9-]{36})$/);
    if (match) {
      const bytes = await storage.read(mediaStorageKey(match[1]));
      doc.image(bytes, x + 16, signatureY + 28, {
        fit: [signatureWidth - 32, 54],
        align: "center",
        valign: "center",
      });
    } else {
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor("#888888")
        .text("Não informada", x + 12, signatureY + 49, {
          width: signatureWidth - 16,
          align: "center",
          lineBreak: false,
        });
    }
    doc
      .moveTo(x + 16, signatureY + 90)
      .lineTo(x + signatureWidth - 16, signatureY + 90)
      .strokeColor("#999999")
      .lineWidth(0.4)
      .stroke();
    if (captions[index])
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor("#222222")
        .text(captions[index], x + 12, signatureY + 99, {
          width: signatureWidth - 24,
          align: "center",
          lineGap: 2,
        });
  }
  doc.y = signatureY + signatureHeight + 8;

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    // Draw chrome once, including pages created automatically by long text.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    pageHeader(i === 0);
    footer(i + 1, range.count);
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return finished;
}
