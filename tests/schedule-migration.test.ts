import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pool } from "../server/db.js";
test("migration preserva identidade, dias e horários legados com pausa no período correto", async () => {
  if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
    throw Error("Use somente brlift_test.");
  const db = await pool.connect(),
    schema = "qa_schedule_" + crypto.randomBytes(6).toString("hex");
  try {
    await db.query("BEGIN");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema},public`);
    await db.query(`CREATE TABLE app_instance(database_id text,contract_version integer DEFAULT 2 CONSTRAINT app_instance_contract_version_check CHECK(contract_version=2));
    INSERT INTO app_instance VALUES('same-database',2);
    CREATE TABLE service_order_days(service_order_id text,id text,date date,hourmeter_lower numeric,
      outbound_start time,outbound_end time,work_start time,work_end time,inbound_start time,inbound_end time,pause_period text,pause_minutes numeric,PRIMARY KEY(service_order_id,id));
    INSERT INTO service_order_days VALUES('r','d','2026-10-09',123,'07:00','08:00','22:00','02:00',NULL,NULL,'work',30);`);
    const before = (await db.query("SELECT * FROM service_order_days")).rows;
    await db.query(
      await fs.readFile("database/002_schedule_periods.sql", "utf8"),
    );
    assert.deepEqual(
      (await db.query("SELECT * FROM service_order_days")).rows,
      before,
    );
    assert.deepEqual(
      (await db.query("SELECT database_id,contract_version FROM app_instance"))
        .rows,
      [{ database_id: "same-database", contract_version: 3 }],
    );
    const rows = (
      await db.query(
        "SELECT kind,start_time,end_time,pause_minutes FROM service_order_day_periods ORDER BY position",
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, "outbound");
    assert.equal(rows[0].pause_minutes, null);
    assert.equal(rows[1].kind, "work");
    assert.equal(Number(rows[1].pause_minutes), 30);
    assert.equal(rows[1].end_time, "02:00:00");
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
});
