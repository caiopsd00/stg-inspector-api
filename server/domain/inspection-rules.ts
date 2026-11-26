import { templateInspectionSections } from "../../contracts/inspection-template.js";
import type { Inspection } from "../../contracts/types.js";
import {
  hasDayData,
  readingIssue,
  validateSchedule,
} from "../../contracts/domain.js";
import { date, fail, year } from "../relational-utils.js";

export function normalizeInspection(inspection: Inspection, keepEmptyDays = false) {
  if (
    !inspection.documentFields ||
    !inspection.documentImages ||
    !Array.isArray(inspection.sections)
  )
    throw fail(422, "Estrutura da inspeção inválida.");
  if (!keepEmptyDays && inspection.days)
    inspection.days = inspection.days.filter(hasDayData);
  const items = inspection.sections.flatMap((section) => section.items || []);
  const expected = templateInspectionSections.flatMap((section) =>
    section.items.map((item) => item.code),
  );
  const itemsByCode = new Map(items.map((item) => [item.code, item]));
  if (
    items.length !== expected.length ||
    itemsByCode.size !== expected.length ||
    expected.some((code) => !itemsByCode.has(code))
  )
    throw fail(422, "Checklist deve corresponder ao template oficial.");
  if (
    items.some(
      (item) =>
        item.situation && !["A", "B", "C", "D"].includes(item.situation),
    )
  )
    throw fail(422, "Situação de item inválida.");
  inspection.sections = templateInspectionSections.map((section) => ({
    id: section.id,
    name: section.name,
    items: section.items.map((item) => ({
      ...itemsByCode.get(item.code)!,
      ...item,
    })),
  }));
}

export function validateInspectionCompletion(inspection: Inspection) {
  validateSchedule(inspection.days || [], true, inspection.formRevision === 2);
  year(inspection.documentFields["005"]);
  date(inspection.documentFields["010"], true);
  date(inspection.documentFields["012"], true);
  for (const key of ["006", "007", "hourmeterUpper"])
    if (readingIssue(inspection.documentFields[key]))
      throw Error("KM e horímetros devem ser números não negativos ou N/A.");
  const twoSignatures =
    inspection.formRevision === 2 || !inspection.signature?.uri;
  if (
    inspection.sections.some((section) =>
      section.items.some((item) => !item.situation),
    ) ||
    (twoSignatures &&
      (!inspection.technicianSignature?.uri || !inspection.clientSignature?.uri))
  )
    throw Error(
      "Complete o checklist e as assinaturas do técnico e do cliente para finalizar.",
    );
  if (
    twoSignatures &&
    !["Aprovada", "Rejeitada"].includes(inspection.documentFields["011"])
  )
    throw Error("Selecione o resultado da vistoria para finalizar.");
}
