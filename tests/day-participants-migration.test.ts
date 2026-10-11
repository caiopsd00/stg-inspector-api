import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pool } from "../server/db.js";
test("migration de participação mantém dados legados e identidade sem inventar presenças", async () => {
  if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
    throw Error("Use somente brlift_test.");
  const db = await pool.connect(),
    schema = "qa_presence_" + crypto.randomBytes(6).toString("hex");
  try {
    await db.query("BEGIN");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema},public`);
    await db.query(`CREATE DOMAIN nonnegative_reading AS numeric CHECK(VALUE>=0);
      CREATE TABLE app_instance(database_id text,contract_version integer DEFAULT 3 CONSTRAINT app_instance_contract_version_check CHECK(contract_version=3));
      INSERT INTO app_instance VALUES('unchanged',3);
      CREATE TABLE technicians(id text PRIMARY KEY);
      CREATE TABLE service_order_team(service_order_id text,technician_id text,PRIMARY KEY(service_order_id,technician_id));
      CREATE TABLE service_order_days(service_order_id text,id text,hourmeter_lower numeric,odometer_start numeric,work_start time,PRIMARY KEY(service_order_id,id));
      INSERT INTO service_order_days VALUES('r','d',123,456,'08:00');`);
    const before = (await db.query("SELECT * FROM service_order_days")).rows[0];
    await db.query(
      await fs.readFile("database/003_day_participants.sql", "utf8"),
    );
    const after = (await db.query("SELECT * FROM service_order_days")).rows[0];
    assert.deepEqual(after, {
      ...before,
      notes: "",
      participants_defined: false,
    });
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM service_order_day_participants",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual((await db.query("SELECT * FROM app_instance")).rows, [
      { database_id: "unchanged", contract_version: 4 },
    ]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
});
