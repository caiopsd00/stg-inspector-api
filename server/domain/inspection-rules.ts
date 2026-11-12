import { templateInspectionSections } from "../../contracts/inspection-template.js";
import type { Inspection } from "../../contracts/types.js";
import {
  hasDayData,
  readingIssue,
  validateSchedule,
} from "../../contracts/domain.js";
import { fail } from "../relational-utils.js";

export function validateInspection(inspection: Inspection, finalized: boolean) {
  if (
    !inspection.documentFields ||
    !inspection.documentImages ||
    !Array.isArray(inspection.sections)
  )
    throw fail(422, "Estrutura da inspeção inválida.");
  try {
    validateSchedule(
      inspection.days || [],
      finalized,
      inspection.formRevision === 2,
    );
    for (const key of ["006", "007", "hourmeterUpper"])
      if (readingIssue(inspection.documentFields[key]))
        throw Error("KM e horímetros devem ser números não negativos ou N/A.");
  } catch (error) {
    throw fail(422, (error as Error).message);
  }
  if (inspection.days) inspection.days = inspection.days.filter(hasDayData);
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
  if (
    finalized &&
    (items.some((item) => !item.situation) ||
      ((inspection.formRevision === 2 || !inspection.signature?.uri) &&
        (!inspection.technicianSignature?.uri ||
          !inspection.clientSignature?.uri)))
  )
    throw fail(
      422,
      "Complete o checklist e as assinaturas do técnico e do cliente para finalizar.",
    );
  if (
    finalized &&
    (inspection.formRevision === 2 || !inspection.signature?.uri) &&
    !["Aprovada", "Rejeitada"].includes(inspection.documentFields["011"])
  )
    throw fail(422, "Selecione o resultado da vistoria para finalizar.");
  inspection.sections = templateInspectionSections.map((section) => ({
    id: section.id,
    name: section.name,
    items: section.items.map((item) => ({
      ...itemsByCode.get(item.code)!,
      ...item,
    })),
  }));
}
