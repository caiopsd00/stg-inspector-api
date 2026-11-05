import type { Entry } from "../../contracts/domain.js";
import { documentForRecord } from "../documents.js";
import { getObjectStorage } from "../object-storage/index.js";
import { concurrencySetting, createConcurrencyLimit } from "../concurrency.js";

type GenerateDocument = (
  item: Entry,
  format: "pdf" | "docx",
) => Promise<Buffer>;

export function createDocumentService(
  generate: GenerateDocument = (item, format) =>
    documentForRecord(item, format, getObjectStorage()),
  limit = concurrencySetting("DOCUMENT_CONCURRENCY"),
) {
  const run = createConcurrencyLimit(
    limit,
    "Há outro documento em geração. Aguarde e tente novamente.",
  );
  return (item: Entry, format: "pdf" | "docx") =>
    run(() => generate(item, format));
}
