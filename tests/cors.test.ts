import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp } from "../server/app.js";

async function preflight(allowAll: string | undefined, origin: string) {
  const previousAllowAll = process.env.CORS_ALLOW_ALL_ORIGINS;
  const previousWebOrigin = process.env.WEB_ORIGIN;
  try {
    process.env.WEB_ORIGIN =
      "https://app.example.test, https://admin.example.test";
    if (allowAll === undefined) delete process.env.CORS_ALLOW_ALL_ORIGINS;
    else process.env.CORS_ALLOW_ALL_ORIGINS = allowAll;
    const server = createApp().listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
        },
      });
      await response.arrayBuffer();
      return {
        status: response.status,
        origin: response.headers.get("Access-Control-Allow-Origin"),
        credentials: response.headers.get("Access-Control-Allow-Credentials"),
        vary: response.headers.get("Vary"),
      };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    if (previousAllowAll === undefined) delete process.env.CORS_ALLOW_ALL_ORIGINS;
    else process.env.CORS_ALLOW_ALL_ORIGINS = previousAllowAll;
    if (previousWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousWebOrigin;
  }
}

test("CORS restrito aceita apenas origens configuradas", async () => {
  const allowed = await preflight("false", "https://admin.example.test");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.origin, "https://admin.example.test");
  assert.equal(allowed.credentials, "true");
  assert.equal(allowed.vary, "Origin");

  const denied = await preflight("false", "https://other.example.test");
  assert.equal(denied.status, 403);
  assert.equal(denied.origin, null);
});

test("CORS permanece restrito quando a variável não existe", async () => {
  const denied = await preflight(undefined, "https://other.example.test");
  assert.equal(denied.status, 403);
});

test("CORS aberto aceita qualquer origem com credenciais", async () => {
  const allowed = await preflight("true", "https://other.example.test");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.origin, "https://other.example.test");
  assert.equal(allowed.credentials, "true");
  assert.equal(allowed.vary, "Origin");
});
