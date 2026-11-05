// Reports only locations/types, never the value of a suspected credential.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const history = process.argv.includes("--history");
const roots = process.argv.slice(2).filter((arg) => arg !== "--history");
if (!roots.length) roots.push(".");
const patterns = [
  ["chave privada", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["token GitHub", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["chave Google", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["chave AWS", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["segredo Stripe", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["token Slack", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["credencial GCP", /"type"\s*:\s*"service_account"/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
  ["URL com credencial", /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis|https?):\/\/[^\s"'`<>:@]+:[^\s"'`<>@]+@[^\s"'`<>]+/g],
];
let findings = 0;
for (const argument of roots) {
  const root = path.resolve(argument);
  const git = (args, input) => execFileSync("git", args, {
    cwd: root, input, maxBuffer: 64 * 1024 * 1024,
  });
  const report = (file, source, kind, line) => {
    findings++;
    console.error(`${path.basename(root)}:${file}${line ? ":" + line : ""} [${source}] ${kind}`);
  };
  function scan(buffer, file, source) {
    if (buffer.includes(0)) return;
    const text = buffer.toString("utf8");
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (kind === "URL com credencial") {
          if (match[0] === "postgresql://brlift:${POSTGRES_PASSWORD:-brlift_local}@postgres:5432/brlift") continue;
          // Only the documented LOCAL development database is allowlisted.
          try {
            const url = new URL(match[0]);
            if (["postgres:", "postgresql:"].includes(url.protocol) &&
                ["localhost", "127.0.0.1", "postgres"].includes(url.hostname) &&
                url.username === "brlift" && url.password === "brlift_local") continue;
          } catch { /* Report malformed credential URLs too. */ }
        }
        report(file, source, kind, text.slice(0, match.index).split("\n").length);
      }
    }
  }
  const files = new Set(git(["ls-files", "-c", "-o", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean));
  for (const file of files) {
    if (/(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:credentials|service[-_]account)[^/]*\.json|[^/]+\.(?:pem|key|keystore|jks|p12|p8|pfx|dump|sql\.gz))$/i.test(file) && !file.endsWith(".example"))
      report(file, "arquivo", "arquivo sensível não ignorado");
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) scan(fs.readFileSync(absolute), file, "working-tree");
  }
  // Also inspect the index: a secret staged then removed from disk is still publishable.
  const indexed = git(["ls-files", "--stage", "-z"]).toString().split("\0").filter(Boolean);
  const seen = new Set();
  for (const entry of indexed) {
    const [header, file] = entry.split("\t");
    const [mode, oid] = header.split(" ");
    if (mode === "160000" || seen.has(oid)) continue;
    seen.add(oid);
    scan(git(["cat-file", "blob", oid]), file, "index");
  }
  let historical = 0;
  if (history) {
    const objects = git(["rev-list", "--objects", "--branches", "--remotes", "--tags"]).toString().trim().split("\n").filter(Boolean);
    const names = new Map(objects.map((row) => {
      const space = row.indexOf(" ");
      return [space < 0 ? row : row.slice(0, space), space < 0 ? "" : row.slice(space + 1)];
    }));
    const types = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [...names.keys()].join("\n") + "\n").toString().trim().split("\n");
    for (const row of types) {
      const [oid, type] = row.split(" ");
      if (type !== "blob" || seen.has(oid)) continue;
      historical++;
      seen.add(oid);
      scan(git(["cat-file", "blob", oid]), names.get(oid), "histórico " + oid.slice(0, 12));
    }
  }
  console.log(`${path.basename(root)}: ${files.size} arquivos; índice revisado${history ? `; ${historical} blobs históricos adicionais` : ""}.`);
}
if (findings) {
  console.error(`${findings} suspeita(s). Revise antes de publicar; nenhuma credencial foi impressa.`);
  process.exitCode = 1;
} else console.log("Nenhum segredo reconhecido. Esta checagem não substitui revisão de código nem rotação de credenciais expostas.");
