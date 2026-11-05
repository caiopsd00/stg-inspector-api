import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/check-secrets.mjs");
test("checagem de segredos examina working tree, índice e histórico sem imprimir valores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brlift-secret-check-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const secret = "ghp_" + "a".repeat(36);
  const check = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args, root], { encoding: "utf8" });
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(secret), false);
    return { status: result.status, output };
  };
  try {
    git("init", "--quiet");
    fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(root, ".env"), secret);
    assert.equal(check().status, 0, "segredos locais ignorados não são candidatos a publicação");
    fs.writeFileSync(path.join(root, "config.txt"), secret);
    assert.equal(check().status, 1, "arquivo ainda não adicionado também é revisado");
    git("add", "config.txt");
    fs.writeFileSync(path.join(root, "config.txt"), "limpo\n");
    assert.match(check().output, /\[index\] token GitHub/);
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--quiet", "-m", "fixture");
    git("add", "config.txt");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--quiet", "-m", "remove fixture");
    assert.equal(check().status, 0);
    assert.match(check("--history").output, /\[histórico [a-f0-9]+\] token GitHub/);
    fs.writeFileSync(path.join(root, "signing.key"), "sensitive file");
    assert.match(check().output, /arquivo sensível não ignorado/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
