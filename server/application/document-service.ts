import type { Entry } from "../../contracts/domain.js";
import { documentForRecord } from "../documents.js";
import { fail } from "../relational-utils.js";
import { storageDir } from "../storage.js";

export function createDocumentService() {
  let activeDocuments = 0;
  return async (item: Entry, format: "pdf" | "docx") => {
    if (activeDocuments >= 2)
      throw fail(
        429,
        "Há outros documentos em geração. Aguarde e tente novamente.",
      );
    activeDocuments++;
    try {
      return await documentForRecord(item, format, storageDir);
    } finally {
      activeDocuments--;
    }
  };
}
