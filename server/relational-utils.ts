import { z } from "zod";
export const fail = (status: number, message: string) =>
  Object.assign(Error(message), { status });
export type DB = { query: (...args: any[]) => Promise<any> };
// Names passed to these helpers are code-owned, never request parameters.
export async function insert(
  db: DB,
  table: string,
  data: Record<string, unknown>,
) {
  const keys = Object.keys(data);
  return (
    await db.query(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
      Object.values(data),
    )
  ).rows[0];
}
export async function upsert(
  db: DB,
  table: string,
  data: Record<string, unknown>,
) {
  const keys = Object.keys(data);
  const fields = keys.filter(
    (k) => !["id", "created_by", "created_at"].includes(k),
  );
  return (
    await db.query(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT(id) DO UPDATE SET ${fields.map((k) => `${k}=excluded.${k}`).join(",")}, version=${table}.version+1, updated_at=now() RETURNING *`,
      Object.values(data),
    )
  ).rows[0];
}
export function nullable(v: unknown) {
  return v == null || v === "" ? null : String(v);
}
export function numeric(v: unknown, label: string) {
  if (v == null || v === "" || v === "N/A") return null;
  if (typeof v !== "string" && typeof v !== "number")
    throw fail(422, `${label}: valor inválido.`);
  if (
    !/^\d+(?:\.\d{1,3})?$/.test(String(v)) ||
    !Number.isFinite(Number(v)) ||
    Number(v) < 0
  )
    throw fail(
      422,
      `${label}: informe um número não negativo com até três casas decimais ou N/A.`,
    );
  return String(v);
}
export function year(v: unknown) {
  if (v == null || v === "") return null;
  if (!/^\d{4}$/.test(String(v)) || Number(v) < 1800)
    throw fail(422, "Ano de fabricação inválido.");
  return Number(v);
}
export function date(v: unknown, optional = false): string | null {
  if ((v == null || v === "") && optional) return null;
  const raw = String(v ?? "");
  const iso = /^\d{2}\/\d{2}\/\d{4}$/.test(raw)
    ? raw.split("/").reverse().join("-")
    : raw;
  if (!z.string().date().safeParse(iso).success)
    throw fail(422, "Data inválida.");
  return iso;
}
export const isoDate = (v: any): string =>
  !v
    ? ""
    : typeof v === "string"
      ? v.slice(0, 10)
      : v.toISOString().slice(0, 10);
export const brDate = (v: any) => isoDate(v).split("-").reverse().join("/");
export const stamp = (v: any): string =>
  typeof v === "string" ? v : v?.toISOString();
export const reading = (r: any, key: string) =>
  r[key + "_not_applicable"]
    ? "N/A"
    : r[key] == null
      ? ""
      : String(r[key]).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
export const readingColumns = (key: string, v: unknown) => ({
  [key]: numeric(v, key),
  [key + "_not_applicable"]: v === "N/A",
});
export const textNA = (r: any, key: string) =>
  r[key + "_not_applicable"] ? "N/A" : r[key] || "";
export const textNAColumns = (key: string, v: unknown) => ({
  [key]: v === "N/A" ? null : nullable(v),
  [key + "_not_applicable"]: v === "N/A",
});
export const yesNo = (v: any) => (v == null ? "" : v ? "Sim" : "Não");
export const bool = (v: any) => (v === "" || v == null ? null : v === "Sim");
export const time = (v: any) => (v ? String(v).slice(0, 5) : "");
export const fileId = (m: any) => {
  const match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(m?.uri || "");
  if (!match) throw fail(422, "Publique o arquivo antes de salvar.");
  return match[1];
};
export const mediaDTO = (r: any) => ({
  id: r.file_id,
  uri: "/api/media/" + r.file_id,
  name: r.name,
  createdAt: stamp(r.created_at),
  width: r.width,
  height: r.height,
});
export async function audit(
  db: DB,
  userId: string,
  type: string,
  id: string,
  action: string,
  before: any,
  after?: any,
) {
  await insert(db, "audit", {
    user_id: userId,
    entity_type: type,
    entity_id: id,
    action,
    before_data: before ? JSON.stringify(before) : null,
    after_data: after ? JSON.stringify(after) : null,
  });
}
