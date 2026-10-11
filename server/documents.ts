import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInspectionDocxAsync } from "./inspection-docx.js";
import { createReportPdf } from "./report-pdf.js";
import type { Entry } from "../contracts/domain.js";
const run = promisify(execFile);
export async function documentForRecord(
  record: Entry,
  format: "pdf" | "docx",
  storage: string,
) {
  if (record.kind === "reports") {
    if (format !== "pdf")
      throw Object.assign(Error("Atendimento disponível em PDF."), {
        status: 422,
      });
    return createReportPdf(record, storage);
  }
  const docx = await createInspectionDocxAsync({
    ...record.payload,
    finalizedAt:
      record.status === "finalized"
        ? record.updatedAt || new Date().toISOString()
        : undefined,
  });
  if (format === "docx") return docx;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brlift-document-"));
  try {
    const file = path.join(dir, "inspection.docx");
    await fs.writeFile(file, docx);
    await run(
      process.env.SOFFICE_PATH || "soffice",
      [
        "-env:UserInstallation=file://" + path.join(dir, "profile"),
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        file,
      ],
      { timeout: 120000 },
    );
    return await fs.readFile(path.join(dir, "inspection.pdf"));
  } catch (e) {
    console.error(e);
    throw Object.assign(
      Error(
        "Conversão PDF indisponível. Verifique o LibreOffice no servidor; DOCX continua disponível.",
      ),
      { status: 503 },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
