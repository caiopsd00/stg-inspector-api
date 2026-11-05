import assert from "node:assert/strict";
import test from "node:test";

import type { Entry } from "../contracts/domain.js";
import { createDocumentService } from "../server/application/document-service.js";
import {
  concurrencySetting,
  createConcurrencyLimit,
} from "../server/concurrency.js";

test("PDF em andamento não admite outra geração e libera a vaga ao terminar", async () => {
  let finish!: (result: Buffer) => void;
  let calls = 0;
  const generate = createDocumentService(async () => {
    calls++;
    return new Promise<Buffer>((resolve) => {
      finish = resolve;
    });
  }, 1);
  const entry = {} as Entry;
  const first = generate(entry, "pdf");
  await assert.rejects(generate(entry, "docx"), { status: 429 });
  assert.equal(calls, 1);
  finish(Buffer.from("first"));
  assert.equal((await first).toString(), "first");
  const next = generate(entry, "pdf");
  finish(Buffer.from("next"));
  assert.equal((await next).toString(), "next");
});

test("falha de conversão ou upload não deixa o processamento bloqueado", async () => {
  const run = createConcurrencyLimit(1, "Ocupado");
  await assert.rejects(
    run(async () => {
      throw Error("Falha de disco");
    }),
    /Falha de disco/,
  );
  assert.equal(await run(async () => "recuperado"), "recuperado");
  await assert.rejects(
    run(() => {
      throw Error("Falha síncrona");
    }),
    /Falha síncrona/,
  );
  assert.equal(
    await run(async () => "recuperado novamente"),
    "recuperado novamente",
  );
});

test("concorrência inválida é rejeitada em vez de liberar trabalho sem limite", () => {
  const name = "BRLIFT_TEST_CONCURRENCY";
  const before = process.env[name];
  try {
    delete process.env[name];
    assert.equal(concurrencySetting(name), 1);
    for (const invalid of ["", "0", "-1", "1.5", "5", "Infinity", "NaN"]) {
      process.env[name] = invalid;
      assert.throws(() => concurrencySetting(name), /inteiro entre 1 e 4/);
    }
    process.env[name] = "2";
    assert.equal(concurrencySetting(name), 2);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});
