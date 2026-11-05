import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../server/app.js";
import { createAttemptLimiter } from "../server/attempt-limiter.js";
import { httpConfig } from "../server/http-config.js";

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
