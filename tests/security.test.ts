import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../server/app.js";
import { createAttemptLimiter } from "../server/attempt-limiter.js";
import { httpConfig } from "../server/http-config.js";

// Resolve from the SDK, not from an unrelated direct test dependency: this is
// the same transitive parser/builder that @google-cloud/storage actually loads.
const projectRequire = createRequire(join(process.cwd(), "package.json"));
const storageRequire = createRequire(projectRequire.resolve("@google-cloud/storage"));
const xmlEntry = storageRequire.resolve("fast-xml-parser");

test("parser XML do SDK está corrigido e corresponde à versão do lockfile", () => {
  const installed = JSON.parse(readFileSync(join(dirname(dirname(xmlEntry)), "package.json"), "utf8"));
  const locked = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(installed.name, "fast-xml-parser");
  assert.equal(installed.version, locked.packages["node_modules/fast-xml-parser"].version);
  const [major, minor] = installed.version.split(".").map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 12), "GHSA-474x-hrwr-fgx4 afeta versões até 5.11.2.");
});

test("parser e builder XML mantêm o formato multipart usado pelo SDK GCS", () => {
  const { XMLParser, XMLBuilder } = storageRequire("fast-xml-parser");
  const parser = new XMLParser();
  const response = parser.parse(
    '<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>qa-private</Bucket><Key>fotos/a&amp;b.jpg</Key><UploadId>QA+SAFE==</UploadId></InitiateMultipartUploadResult>',
  );
  assert.equal(response.InitiateMultipartUploadResult.UploadId, "QA+SAFE==");
  assert.equal(response.InitiateMultipartUploadResult.Key, "fotos/a&b.jpg");
  const parts = [
    { PartNumber: 1, ETag: '"etag-one"' },
    { PartNumber: 2, ETag: '"etag-two"' },
  ];
  const builder = new XMLBuilder({ arrayNodeName: "Part" });
  const body = `<CompleteMultipartUpload>${builder.build(parts)}</CompleteMultipartUpload>`;
  assert.deepEqual(parser.parse(body).CompleteMultipartUpload.Part, parts);
});

test("XML malformado em stopNodes é rejeitado sem varredura quadrática", () => {
  // Isolate the adversarial input in a bounded process. A regression must fail
  // this test, not freeze the test runner. No network or application data used.
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { XMLParser } = require(${JSON.stringify(xmlEntry)});
    const input = '<stop>' + '<a '.repeat(250000);
    assert.throws(() => new XMLParser({stopNodes:['stop']}).parse(input), /Unexpected end of stop/);
    process.stdout.write('rejected');
  `], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "rejected");
});

test("produção recusa CORS aberto, origens inseguras e confiança irrestrita em proxies", () => {
  const valid = { NODE_ENV: "production", WEB_ORIGIN: "https://app.example.test", TRUST_PROXY: "1" };
  assert.equal(httpConfig(valid).trustProxy, 1);
  assert.equal(httpConfig({}).trustProxy, false);
  assert.throws(() => httpConfig({ ...valid, CORS_ALLOW_ALL_ORIGINS: "true" }), /CORS/);
  assert.throws(() => httpConfig({ NODE_ENV: "production" }), /WEB_ORIGIN/);
  assert.throws(() => httpConfig({ ...valid, WEB_ORIGIN: "http://app.example.test" }), /HTTPS/);
  assert.throws(() => httpConfig({ ...valid, TRUST_PROXY: "true" }), /TRUST_PROXY/);
});

test("limite de login expira, pode ser limpo e não acumula chaves sem limite", () => {
  let now = 0;
  const limiter = createAttemptLimiter(2, 1000, 2, () => now);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  now = 1001;
  assert.equal(limiter.allow("a"), true);
  limiter.reset("a");
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  limiter.allow("b");
  limiter.allow("c");
  assert.equal(limiter.allow("a"), true);
});

test("login limita JSON antes de consultar o banco e não reflete corpo inválido", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`;
  try {
    const oversized = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a".repeat(20000) }) });
    assert.equal(oversized.status, 413);
    await oversized.arrayBuffer();
    const malformed = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{private-marker" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes("private-marker"), false);
    const compressed = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "not-gzip" });
    assert.equal(compressed.status, 415);
    await compressed.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
