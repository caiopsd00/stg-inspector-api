import { test } from "node:test";
import assert from "node:assert/strict";
import {
  date,
  year,
  numeric,
  reading,
  readingColumns,
  textNAColumns,
} from "../server/relational-utils.js";
test("colunas distinguem ausência, zero e não aplicável sem perder precisão", () => {
  assert.deepEqual(readingColumns("km", ""), {
    km: null,
    km_not_applicable: false,
  });
  assert.deepEqual(readingColumns("km", "0"), {
    km: "0",
    km_not_applicable: false,
  });
  assert.deepEqual(readingColumns("km", "N/A"), {
    km: null,
    km_not_applicable: true,
  });
  assert.equal(
    reading({ km: "999999999999999.123" }, "km"),
    "999999999999999.123",
  );
  assert.equal(reading({ km: "0.000" }, "km"), "0");
  assert.equal(reading({ km: "1.250" }, "km"), "1.25");
  assert.deepEqual(textNAColumns("plate", "N/A"), {
    plate: null,
    plate_not_applicable: true,
  });
});
test("adaptador valida números, anos e datas reais", () => {
  assert.equal(date("29/02/2024"), "2024-02-29");
  assert.equal(date("2024-02-29"), "2024-02-29");
  assert.equal(date("", true), null);
  assert.throws(() => date("29/02/2025"));
  assert.throws(() => date(""));
  for (const value of ["-1", "Infinity", "NaN", "1.1234", "abc"])
    assert.throws(() => numeric(value, "KM"));
  assert.equal(year("2026"), 2026);
  assert.equal(year(""), null);
  assert.throws(() => year("26"));
});
