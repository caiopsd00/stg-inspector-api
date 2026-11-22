import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.js";
import { pool, transaction } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { hashPassword } from "../server/auth.js";
import { uploadMedia } from "../server/application/media-service.js";
import { newReport, newDay, dayTotals } from "../contracts/domain.js";
import {
  createTemplateSections,
  documentFields,
} from "../contracts/inspection-template.js";
test(
  "persistência, filtros, CRUD, unicidade, versões, arquivos e documentos",
  { skip: !process.env.DATABASE_URL, timeout: 180000 },
  async (t) => {
    if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
      throw Error("Use banco brlift_test exclusivo para integração.");
    // Node 24.2 schedules subtests without returning their completion promise.
    // Explicitly wait so the shared server/pool cannot close while a scenario runs.
    const scenario = async (name: string, fn: () => Promise<void>) => {
      let failure: unknown;
      await new Promise<void>((resolve) => {
        void t.test(name, async () => {
          try {
            await fn();
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            resolve();
          }
        });
      });
      if (failure) throw failure;
    };
    await migrate();
    await scenario(
      "migration 009 contém somente DDL e preserva os cadastros",
      async () => {
        const db = await pool.connect();
        const sql = await fs.readFile(
          "database/009_unified_professionals.sql",
          "utf8",
        );
        assert.doesNotMatch(
          sql,
          /INSERT INTO users|UPDATE technicians|sync_professional_user/,
        );
        const statements = sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((statement) => statement.trim())
          .filter(Boolean);
        assert.equal(statements.length, 4);
        for (const statement of statements)
          assert.match(statement, /^ALTER TABLE\s/i);
        try {
          await db.query("BEGIN");
          await db.query("CREATE SCHEMA upgrade_professionals");
          await db.query("SET LOCAL search_path TO upgrade_professionals");
          await db.query(
            "CREATE TABLE users(id text PRIMARY KEY,name text,email text NOT NULL,password_hash text NOT NULL,role text,active boolean); CREATE TABLE technicians(id text PRIMARY KEY,name text,cpf text,user_id text UNIQUE REFERENCES users(id),active boolean,version int DEFAULT 1,updated_at timestamptz)",
          );
          await db.query(
            "INSERT INTO users VALUES('existing','HOMÔNIMO','existing@example.test','hash','technician',true); INSERT INTO technicians(id,name,cpf,user_id,active) VALUES('linked','HOMÔNIMO','11111111111','existing',true),('unlinked','HOMÔNIMO','22222222222',NULL,true)",
          );
          await db.query("SAVEPOINT before_migration");
          await assert.rejects(
            db.query(sql),
            // Native NOT NULL validation, not a procedural migration preflight.
            (error: any) => error.code === "23502",
          );
          await db.query("ROLLBACK TO SAVEPOINT before_migration");
          assert.equal(
            (await db.query("SELECT count(*)::int n FROM users")).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT user_id FROM technicians WHERE id='unlinked'",
              )
            ).rows[0].user_id,
            null,
          );
          // Explicit operator repair in the TEST fixture, not in a migration.
          await db.query(
            "INSERT INTO users VALUES('second','HOMÔNIMO','second@example.test','hash','technician',true); UPDATE technicians SET user_id='second' WHERE id='unlinked'",
          );
          const before = (
            await db.query("SELECT * FROM technicians ORDER BY id")
          ).rows;
          await db.query(sql);
          assert.deepEqual(
            (await db.query("SELECT * FROM technicians ORDER BY id")).rows,
            before,
          );
          assert.equal(
            (await db.query("SELECT count(*)::int n FROM users")).rows[0].n,
            2,
          );
          await assert.rejects(
            db.query(
              "INSERT INTO technicians(id,name,cpf) VALUES('orphan','NO','33333333333')",
            ),
            { code: "23502" },
          );
        } finally {
          await db.query("ROLLBACK");
          db.release();
        }
      },
    );
    const tag = crypto.randomUUID(),
      email = tag + "@example.test",
      password = crypto.randomBytes(16).toString("hex");
    const userCpf = tag.replace(/\D/g, "").padEnd(11, "0").slice(0, 11);
    await assert.rejects(
      pool.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'Sem técnico',$3,'technician_admin')",
        [crypto.randomUUID(), "orphan-" + tag + "@example.test", "hash"],
      ),
      /precisa ter um cadastro de técnico vinculado/,
    );
    await transaction(async (db) => {
      await db.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'Usuário de teste',$3,'technician_admin')",
        [tag, email, await hashPassword(password)],
      );
      await db.query(
        "INSERT INTO technicians(id,name,cpf,user_id) VALUES($1,'Usuário de teste',$2,$3)",
        [crypto.randomUUID(), userCpf, tag],
      );
    });
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = "http://127.0.0.1:" + (server.address() as any).port;
    let token = "",
      databaseId = "";
    async function call(
      url: string,
      body?: any,
      method = body ? "POST" : "GET",
      expected = 200,
    ) {
      const res = await fetch(base + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-BRLIFT-Database": databaseId,
          "X-BRLIFT-Contract": "4",
          Authorization: "Bearer " + token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = res.status === 204 ? null : await res.json();
      assert.equal(res.status, expected, JSON.stringify(value));
      return value;
    }
    try {
      await call("/api/reports", undefined, "GET", 401);
      const auth = await call("/api/auth/login", { email, password });
      token = auth.token;
      databaseId = auth.databaseId;
      assert.equal(auth.contractVersion, 4);
      const registeredEmail = "new-" + tag + "@example.test";
      const registeredPassword = crypto.randomBytes(12).toString("hex");
      const registeredCpf = String(
        (BigInt(userCpf) + 1n) % 100_000_000_000n,
      ).padStart(11, "0");
      const registered = await call(
        "/api/users",
        {
          name: "Novo técnico " + tag,
          email: registeredEmail,
          cpf: registeredCpf,
          password: registeredPassword,
          role: "technician",
        },
        "POST",
        201,
      );
      assert.equal(registered.technician.identifier, registeredCpf);
      const managedUsers = await call("/api/users");
      assert.ok(managedUsers.users.some((item: any) => item.id === tag));
      assert.equal("password_hash" in managedUsers.users[0], false);
      const editedCpf = String(
        (BigInt(userCpf) + 2n) % 100_000_000_000n,
      ).padStart(11, "0");
      const edited = await call(
        `/api/users/${tag}`,
        {
          name: "Usuário atualizado " + tag,
          email,
          cpf: editedCpf,
          role: "technician_admin",
        },
        "PUT",
      );
      assert.equal(edited.technician.identifier, editedCpf);
      assert.equal(
        (await call("/api/auth/me")).user.name,
        "Usuário atualizado " + tag,
      );
      await call(`/api/users/${tag}/active`, { active: false }, "PUT", 409);
      await scenario(
        "administrador puro não é técnico; promoção e rebaixamento preservam o vínculo histórico",
        async () => {
          const pureEmail = "pure-" + tag + "@example.test";
          const body = {
            name: "ADMIN QA",
            email: pureEmail,
            role: "admin",
            password: registeredPassword,
          };
          const pure = await call("/api/users", body, "POST", 201);
          assert.equal(pure.technician, null);
          const id = pure.user.id;
          const cpf = String(
            (BigInt(userCpf) + 4n) % 100_000_000_000n,
          ).padStart(11, "0");
          const promoted = await call(
            `/api/users/${id}`,
            { ...body, role: "technician_admin", cpf },
            "PUT",
          );
          assert.equal(promoted.technician.identifier, cpf);
          assert.equal(
            (await call("/api/catalog/technicians")).items.find(
              (item: any) => item.id === promoted.technician.id,
            )?.active,
            true,
          );
          const demoted = await call(`/api/users/${id}`, body, "PUT");
          assert.equal(demoted.technician, null);
          assert.ok(
            !(await call("/api/catalog/technicians")).items.some(
              (item: any) => item.id === promoted.technician.id,
            ),
          );
          const history = (
            await pool.query("SELECT cpf,active FROM technicians WHERE id=$1", [
              promoted.technician.id,
            ])
          ).rows[0];
          assert.deepEqual(history, { cpf, active: false });
          const previous = token;
          try {
            token = (
              await call("/api/auth/login", {
                email: pureEmail,
                password: registeredPassword,
              })
            ).token;
            assert.ok(
              (await call("/api/users")).users.some(
                (user: any) => user.id === id && user.technician === null,
              ),
            );
          } finally {
            token = previous;
          }
        },
      );
      const technician = (await call("/api/catalog/technicians")).items.find(
        (item: any) => item.id === registered.technician.id,
      );
      assert.equal(technician.data.userId, registered.user.id);
      const technicianLogin = await call(
        "/api/auth/login",
        { email: registeredEmail, password: registeredPassword },
        "POST",
      );
      const adminToken = token;
      token = technicianLogin.token;
      const ownProfile = await call("/api/profile");
      assert.equal(ownProfile.user.id, registered.user.id);
      assert.equal(ownProfile.user.cpf, registeredCpf);
      assert.equal("password_hash" in ownProfile.user, false);
      const newProfileEmail = "profile-" + tag + "@example.test";
      const newProfilePassword = crypto.randomBytes(16).toString("hex");
      const newProfileCpf = String(
        (BigInt(userCpf) + 3n) % 100_000_000_000n,
      ).padStart(11, "0");
      const profileEdit = {
        name: "Técnico atualizado " + tag,
        email: newProfileEmail,
        cpf: newProfileCpf,
        currentPassword: registeredPassword,
        password: newProfilePassword,
      };
      await call("/api/profile", { ...profileEdit, role: "admin" }, "PUT", 422);
      await call(
        "/api/profile",
        { ...profileEdit, currentPassword: "senha-incorreta" },
        "PUT",
        401,
      );
      const updatedProfile = await call("/api/profile", profileEdit, "PUT");
      assert.equal(updatedProfile.user.role, "technician");
      assert.equal(updatedProfile.technician.identifier, newProfileCpf);
      assert.equal((await call("/api/auth/me")).user.name, profileEdit.name);
      assert.equal((await call("/api/profile")).user.email, newProfileEmail);
      await call(
        "/api/auth/login",
        { email: registeredEmail, password: registeredPassword },
        "POST",
        401,
      );
      const newLogin = await call(
        "/api/auth/login",
        { email: newProfileEmail, password: newProfilePassword },
        "POST",
      );
      assert.equal(newLogin.user.role, "technician");
      await call("/api/users", undefined, "GET", 403);
      await call(`/api/users/${tag}`, profileEdit, "PUT", 403);
      await call(
        "/api/users",
        {
          name: "Não permitido",
          email: "blocked-" + tag + "@example.test",
          cpf: "98765432100",
          password: "0123456789",
          role: "technician",
        },
        "POST",
        403,
      );
      token = adminToken;
      await call(
        `/api/users/${registered.user.id}/active`,
        { active: false },
        "PUT",
      );
      assert.equal(
        (await call("/api/users")).users.find(
          (item: any) => item.id === registered.user.id,
        ).active,
        false,
      );
      await call(
        `/api/users/${registered.user.id}/active`,
        { active: true },
        "PUT",
      );
      await call(
        "/api/users",
        {
          name: "Inválido",
          email: "invalid-" + tag + "@example.test",
          cpf: "123",
          password: "0123456789",
          role: "technician",
        },
        "POST",
        422,
      );
      const outdated = await fetch(base + "/api/reports/outdated", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-BRLIFT-Database": databaseId,
          "X-BRLIFT-Contract": "3",
          Authorization: "Bearer " + token,
        },
        body: "{}",
      });
      assert.equal(outdated.status, 428);
      assert.equal((await outdated.json()).code, "CLIENT_OUTDATED");
      const clientId = crypto.randomUUID(),
        techId = crypto.randomUUID(),
        eqId = crypto.randomUUID();
      const doc = String(Date.now()).slice(-11);
      await call(
        "/api/catalog/clients/" + clientId,
        {
          name: "Cliente teste " + tag,
          identifier: "123" + doc,
          baseVersion: 0,
        },
        "PUT",
      );
      await call(
        "/api/catalog/clients/" + crypto.randomUUID(),
        { name: "Duplicado", identifier: "123" + doc, baseVersion: 0 },
        "PUT",
        409,
      );
      await call(
        "/api/catalog/technicians/" + techId,
        { name: "Técnico teste", identifier: doc, baseVersion: 0 },
        "PUT",
      );
      await call(
        "/api/catalog/equipment/" + eqId,
        {
          name: "Guindaste teste",
          clientId,
          data: {
            type: "Guindaste",
            brand: "Liebherr",
            model: "LTM",
            serial: "SERIAL",
            nominalCapacity: "80 t",
            odometer: "100",
            hourmeter: "200",
            hourmeterLower: "300",
            hourmeterUpper: "400",
          },
          baseVersion: 0,
        },
        "PUT",
      );
      await scenario(
        "cadastro rápido cria usuário sem login; edição e ativação mantêm os mesmos IDs",
        async () => {
          const tid = crypto.randomUUID(),
            cpf = String(crypto.randomInt(100000000, 999999999)).padStart(
              11,
              "0",
            );
          await call(
            "/api/catalog/technicians/" + tid,
            {
              name: "Profissional básico " + tag,
              identifier: cpf,
              baseVersion: 0,
            },
            "PUT",
          );
          const basic = (await call("/api/users")).users.find(
            (u: any) => u.technician?.id === tid,
          );
          assert.ok(basic);
          assert.equal(basic.hasAccess, false);
          assert.equal(basic.email, "");
          const creds = (
            await pool.query(
              "SELECT email,password_hash FROM users WHERE id=$1",
              [basic.id],
            )
          ).rows[0];
          assert.deepEqual(creds, { email: null, password_hash: null });
          const newCpf = String(BigInt(cpf) + 1n).padStart(11, "0");
          await call(
            "/api/users/" + basic.id,
            {
              name: "Profissional corrigido",
              email: "",
              cpf: newCpf,
              role: "technician",
            },
            "PUT",
          );
          const selected = (await call("/api/catalog/technicians")).items.find(
            (i: any) => i.id === tid,
          );
          assert.equal(selected.data.userId, basic.id);
          assert.equal(selected.identifier, newCpf);
          assert.equal(selected.name, "Profissional corrigido");
          await call(
            "/api/users/" + basic.id,
            {
              name: selected.name,
              email: "basic-" + tag + "@example.test",
              cpf: newCpf,
              role: "technician",
            },
            "PUT",
            422,
          );
          await call(
            "/api/users/" + basic.id,
            {
              name: selected.name,
              email: "basic-" + tag + "@example.test",
              password,
              cpf: newCpf,
              role: "technician",
            },
            "PUT",
          );
          await call("/api/auth/login", {
            email: "basic-" + tag + "@example.test",
            password,
          });
          const current = (await call("/api/catalog/technicians")).items.find(
            (i: any) => i.id === tid,
          );
          await call(
            "/api/catalog/technicians/" + tid,
            { baseVersion: current.version },
            "DELETE",
          );
          assert.equal(
            (await call("/api/users")).users.find((u: any) => u.id === basic.id)
              .active,
            false,
          );
          assert.ok(
            !(await call("/api/catalog/technicians")).items.some(
              (i: any) => i.id === tid,
            ),
          );
          await call(
            "/api/auth/login",
            { email: "basic-" + tag + "@example.test", password },
            "POST",
            401,
          );
        },
      );
      const partId = crypto.randomUUID();
      const equipment = (await call("/api/catalog/equipment")).items.find(
        (item: any) => item.id === eqId,
      );
      for (const key of [
        "odometer",
        "hourmeter",
        "hourmeterLower",
        "hourmeterUpper",
      ])
        assert.equal(equipment.data[key], undefined);
      assert.equal(equipment.data.nominalCapacity, "80 t");
      await call(
        "/api/catalog/parts/" + partId,
        {
          name: "Peça teste",
          identifier: "P-" + tag,
          baseVersion: 0,
          data: { supplier: "Fornecedor" },
        },
        "PUT",
      );
      const part = await call(
        "/api/catalog/parts/" + partId,
        {
          name: "Peça teste",
          identifier: "NEW-" + tag,
          baseVersion: 1,
          data: { supplier: "Fornecedor" },
        },
        "PUT",
      );
      assert.deepEqual(part.item.data.codeHistory, ["P-" + tag.toUpperCase()]);
      assert.equal(
        (await call("/api/parts/by-code/" + encodeURIComponent("P-" + tag)))
          .item.id,
        partId,
      );
      const photo = await sharp({
        create: { width: 900, height: 450, channels: 3, background: "#bd932f" },
      })
        .png()
        .toBuffer();
      const dataUrl = "data:image/png;base64," + photo.toString("base64");
      const media = (
        await call("/api/media", { dataUrl, name: "foto.png" }, "POST", 201)
      ).media;
      await scenario(
        "falha no cadastro da mídia limpa o arquivo temporário",
        async () => {
          const uniqueImage = await sharp({
            create: {
              width: 2,
              height: 2,
              channels: 3,
              background: "#123456",
            },
          })
            .png()
            .toBuffer();
          const mediaDir = path.resolve(
            process.env.STORAGE_DIR || "storage",
            "media",
          );
          const before = new Set(await fs.readdir(mediaDir));
          await assert.rejects(
            uploadMedia(
              {
                id: crypto.randomUUID(),
                name: "Inexistente",
                email: "missing@example.test",
                role: "technician",
              },
              "data:image/png;base64," + uniqueImage.toString("base64"),
              "teste.png",
            ),
          );
          assert.deepEqual(new Set(await fs.readdir(mediaDir)), before);
        },
      );
      assert.equal(
        (await call("/api/media", { dataUrl, name: "foto.png" }, "POST", 201))
          .media.id,
        media.id,
      );
      const p = newReport();
      p.equipment = {
        ...equipment.data,
        odometer: "100",
        hourmeterLower: "300",
        hourmeterUpper: "N/A",
      };
      const tech2 = crypto.randomUUID(),
        aux = crypto.randomUUID();
      for (const [extraId, name, offset] of [
        [tech2, "Segundo técnico", 1],
        [aux, "Auxiliar da equipe", 2],
      ] as const) {
        await call(
          "/api/catalog/technicians/" + extraId,
          {
            name,
            identifier: String(Number(doc) + offset).padStart(11, "0"),
            baseVersion: 0,
          },
          "PUT",
        );
      }
      p.additionalTechnicians = [
        { technicianId: tech2, role: "technician" },
        { technicianId: aux, role: "auxiliary" },
      ];
      p.reasons = [
        {
          id: "reason",
          description: "Teste de manutenção",
          pending: "Reavaliar",
          services: [
            {
              id: "service",
              description: "Inspeção do conjunto",
              notes: "Teste",
              photos: [media],
            },
          ],
        },
      ];
      p.technicianSignature = media;
      p.clientSignature = media;
      p.parts = [
        {
          id: "used-part",
          catalogId: partId,
          code: part.item.identifier,
          description: "Peça teste",
          supplier: "Fornecedor",
          quantity: 2.5,
          kind: "replaced",
          codeHistory: part.item.data.codeHistory,
        },
      ];
      p.concluded = "Sim";
      p.released = "Sim";
      p.photosSent = "Sim";
      const day = newDay("day");
      day.hourmeterLower = "301";
      day.hourmeterUpper = "N/A";
      day.work = { start: "08:00", end: "17:00" };
      day.pause = { period: "work", minutes: "60" };
      day.periods = [
        {
          id: "work-1",
          kind: "work",
          start: "08:00",
          end: "17:00",
          pauseMinutes: "60",
        },
        {
          id: "work-2",
          kind: "work",
          start: "18:00",
          end: "19:00",
          pauseMinutes: "15",
        },
        {
          id: "out-1",
          kind: "outbound",
          start: "06:00",
          end: "07:00",
          pauseMinutes: "10",
        },
        {
          id: "out-2",
          kind: "outbound",
          start: "07:00",
          end: "07:30",
          pauseMinutes: "",
        },
        {
          id: "in-1",
          kind: "inbound",
          start: "19:00",
          end: "20:00",
          pauseMinutes: "5",
        },
        {
          id: "in-2",
          kind: "inbound",
          start: "20:15",
          end: "20:45",
          pauseMinutes: "",
        },
      ];
      p.days = [newDay("empty"), day];
      const id = crypto.randomUUID(),
        input = {
          number: "AT-" + tag,
          clientId,
          technicianId: techId,
          equipmentId: eqId,
          date: "2026-09-26",
          status: "finalized",
          payload: p,
          baseVersion: 0,
          mutationId: crypto.randomUUID(),
        };
      await scenario(
        "equipe só de auxiliares persiste e clientes antigos não promovem o primeiro",
        async () => {
          const url = "/api/reports/" + crypto.randomUUID();
          const payload = {
            ...structuredClone(p),
            primaryTechnicianRole: "auxiliary",
            additionalTechnicians: p.additionalTechnicians!.map((person) => ({
              ...person,
              role: "auxiliary",
            })),
          };
          let saved = (
            await call(
              url,
              {
                ...input,
                number: "AUX-" + tag,
                payload,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
            )
          ).item;
          assert.equal(saved.payload.primaryTechnicianRole, "auxiliary");
          assert.ok(
            saved.payload.teamSnapshot.every(
              (person: any) => person.role === "auxiliary",
            ),
          );
          const legacyPayload = {
            ...payload,
            primaryTechnicianRole: undefined,
          };
          saved = (
            await call(
              url,
              {
                ...input,
                number: saved.number,
                payload: legacyPayload,
                baseVersion: saved.version,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
            )
          ).item;
          assert.equal(saved.payload.primaryTechnicianRole, "auxiliary");
          await pool.query("DELETE FROM service_orders WHERE id=$1", [
            saved.id,
          ]);
        },
      );
      await scenario(
        "API rejeita horários e KM regressivos, inclusive entre tipos de período",
        async () => {
          for (const field of [
            "start",
            "odometerStart",
            "odometerEnd",
          ] as const) {
            const payload = structuredClone(p);
            const periods = payload.days[1].periods!;
            if (field === "start") periods[1].start = "16:59";
            else {
              periods[2].odometerStart = "0";
              periods[2].odometerEnd = "100";
              periods[3][field] = "5";
            }
            await call(
              "/api/reports/" + crypto.randomUUID(),
              {
                ...input,
                number: crypto.randomUUID(),
                status: "draft",
                payload,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
              422,
            );
          }
        },
      );
      await scenario(
        "descrições históricas do motivo e do serviço persistem e são editadas de forma independente",
        async () => {
          const recordId = crypto.randomUUID();
          const url = "/api/reports/" + recordId;
          const payload = structuredClone(p);
          let version = 0;
          const save = async () => {
            const saved = (
              await call(
                url,
                {
                  ...input,
                  number: "MOTIVO-" + tag,
                  status: "draft",
                  payload,
                  baseVersion: version,
                  mutationId: crypto.randomUUID(),
                },
                "PUT",
              )
            ).item;
            version = saved.version;
            const reloaded = (await call(url)).item;
            assert.deepEqual(reloaded.payload.reasons, saved.payload.reasons);
            const reason = reloaded.payload.reasons[0];
            assert.equal(reason.description, payload.reasons[0].description);
            assert.equal(reason.pending, payload.reasons[0].pending);
            assert.equal(
              reason.services[0].description,
              payload.reasons[0].services[0].description,
            );
            assert.equal(
              reason.services[0].notes,
              payload.reasons[0].services[0].notes,
            );
            assert.deepEqual(
              reason.services[0].photos.map((photo: any) => photo.uri),
              payload.reasons[0].services[0].photos.map((photo) => photo.uri),
            );
            const row = (
              await pool.query(
                "SELECT r.description AS reason,s.description AS service FROM service_order_reasons r JOIN service_order_services s ON s.service_order_id=r.service_order_id AND s.reason_id=r.id WHERE r.service_order_id=$1",
                [recordId],
              )
            ).rows[0];
            assert.equal(row.reason, payload.reasons[0].description);
            assert.equal(
              row.service,
              payload.reasons[0].services[0].description,
            );
          };
          try {
            await save();
            payload.reasons[0].description =
              "Motivo antigo com acentuação revisado";
            await save();
            const reasonBefore = payload.reasons[0].description;
            payload.reasons[0].services[0].description =
              "Serviço revisado sem alterar motivo";
            await save();
            assert.equal(payload.reasons[0].description, reasonBefore);
            // Reports filled while the inputs were merged can have equal texts.
            payload.reasons[0].description =
              payload.reasons[0].services[0].description;
            await save();
            payload.reasons[0].services[0].description =
              "Novo serviço, motivo histórico preservado";
            await save();
          } finally {
            await pool.query("DELETE FROM service_orders WHERE id=$1", [
              recordId,
            ]);
          }
        },
      );
      const first = await call("/api/reports/" + id, input, "PUT");
      await scenario(
        "relatório e inspeção rejeitam virada de dia e persistem a divisão em duas datas",
        async () => {
          for (const kind of ["reports", "inspections"] as const) {
            const recordId = crypto.randomUUID();
            const period = {
              id: "work",
              kind: "work" as const,
              start: "03:30",
              end: "01:00",
              pauseMinutes: "",
              odometerStart: "N/A",
              odometerEnd: "N/A",
            };
            const schedule = {
              ...newDay("first"),
              date: "2026-11-17",
              periods: [period],
            };
            const payload =
              kind === "reports"
                ? { ...newReport(), formRevision: 2, days: [schedule] }
                : {
                    formRevision: 2,
                    documentFields: {},
                    documentImages: {},
                    sections: createTemplateSections(),
                    days: [schedule],
                  };
            const body = {
              ...input,
              number: "SAME-DAY-" + recordId,
              status: "draft",
              payload,
              mutationId: crypto.randomUUID(),
            };
            const rejected = await call(
              "/api/" + kind + "/" + recordId,
              body,
              "PUT",
              422,
            );
            assert.match(JSON.stringify(rejected), /23:59/);
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM " +
                    (kind === "reports" ? "service_orders" : "inspections") +
                    " WHERE id=$1",
                  [recordId],
                )
              ).rows[0].n,
              0,
            );
            period.end = "23:59";
            payload.days.push({
              ...newDay("second"),
              date: "2026-11-18",
              periods: [{ ...period, start: "00:00", end: "01:00" }],
            });
            const saved = (
              await call(
                "/api/" + kind + "/" + recordId,
                { ...body, mutationId: crypto.randomUUID() },
                "PUT",
              )
            ).item;
            assert.equal(saved.payload.days.length, 2);
            assert.equal(dayTotals(saved.payload.days[0]).work, 1229);
            assert.equal(dayTotals(saved.payload.days[1]).work, 60);
            await pool.query(
              "DELETE FROM " +
                (kind === "reports" ? "service_orders" : "inspections") +
                " WHERE id=$1",
              [recordId],
            );
          }
        },
      );
      const rentalId = crypto.randomUUID(),
        vehicleId = crypto.randomUUID();
      const uploadSignature = async (
        kind: string,
        recordId: string,
        signerRole: string,
        signerName: string,
      ) =>
        (
          await call(
            "/api/media",
            {
              dataUrl,
              name: "assinatura.png",
              signature: { kind, recordId, signerRole, signerName },
            },
            "POST",
            201,
          )
        ).media;
      await scenario(
        "relatório atualizado persiste veículo, cobrança, serviço, KM por período e assinatura independente",
        async () => {
          const rental = { name: "LOCADORA QA " + tag, baseVersion: 0 };
          await call("/api/catalog/rentalCompanies/" + rentalId, rental, "PUT");
          await call(
            "/api/catalog/rentalCompanies/" + crypto.randomUUID(),
            { ...rental, name: rental.name.toLowerCase() },
            "PUT",
            409,
          );
          const vehicle = {
            identifier: "QA-" + tag.slice(0, 8),
            baseVersion: 0,
            data: { rentalCompanyId: rentalId },
          };
          await call(
            "/api/catalog/vehicles/" + vehicleId,
            { ...vehicle, data: {} },
            "PUT",
            422,
          );
          const savedVehicle = (
            await call("/api/catalog/vehicles/" + vehicleId, vehicle, "PUT")
          ).item;
          assert.equal(
            savedVehicle.name,
            ("QA" + tag.slice(0, 8)).toUpperCase(),
          );
          assert.equal(savedVehicle.data.model, "");
          assert.equal(savedVehicle.data.color, "");

          const recordId = crypto.randomUUID();
          const url = "/api/reports/" + recordId;
          await call(url + "/filling-start", {}, "POST", 204);
          const startQuery = async () =>
            (
              await pool.query(
                "SELECT started_at FROM record_fill_starts WHERE record_id=$1",
                [recordId],
              )
            ).rows[0]?.started_at;
          const started = await startQuery();
          await call(url + "/filling-start", {}, "POST", 204);
          assert.deepEqual(await startQuery(), started);
          const signTech = await uploadSignature(
            "reports",
            recordId,
            "technician",
            "TÉCNICO QA",
          );
          const signClient = await uploadSignature(
            "reports",
            recordId,
            "client",
            "CLIENTE QA",
          );
          const resignTech = await uploadSignature(
            "reports",
            recordId,
            "technician",
            "TÉCNICO QA REASSINOU",
          );
          assert.equal(signTech.uri, resignTech.uri);
          assert.notEqual(signTech.captureId, resignTech.captureId);
          assert.ok(resignTech.createdAt > signTech.createdAt);

          const revised = {
            ...structuredClone(p),
            formRevision: 2,
            type: "remoto",
            primaryTechnicianCharged: "Não",
            photosSent: undefined,
            additionalTechnicians: p.additionalTechnicians!.map((member) => ({
              ...member,
              charged: "Sim",
            })),
            technicianSignature: {
              ...resignTech,
              signerName: "NOME INJETADO",
              createdAt: "2000-01-01T00:00:00Z",
            },
            clientSignature: signClient,
            reasons: p.reasons.map((reason) => ({
              ...reason,
              services: reason.services.map((service) => ({
                ...service,
                completed: "Sim",
              })),
            })),
            days: [
              {
                ...newDay("remote-day"),
                periods: [
                  {
                    id: "remote-work",
                    kind: "work",
                    start: "08:00",
                    end: "10:00",
                    pauseMinutes: "0",
                    odometerStart: "0",
                    odometerEnd: "N/A",
                  },
                ],
              },
            ],
          };
          const body = {
            ...input,
            date: undefined,
            vehicleId,
            number: "OMIE-" + tag,
            payload: revised,
          };
          const save = (payload: any, status = "finalized", expected = 200) =>
            call(
              url,
              {
                ...body,
                payload,
                status,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
              expected,
            );
          await save(
            { ...revised, primaryTechnicianCharged: "" },
            "finalized",
            422,
          );
          await save(
            { ...revised, reasons: [{ ...revised.reasons[0], services: [] }] },
            "draft",
            422,
          );
          await save(
            { ...revised, technicianSignature: signClient },
            "finalized",
            422,
          );
          const noKm = structuredClone(revised);
          noKm.days[0].periods[0].odometerEnd = "";
          await save(noKm, "finalized", 422);
          const travel = structuredClone(revised);
          travel.days[0].periods[0].kind = "outbound";
          await save(travel, "finalized", 422);
          assert.deepEqual(
            await startQuery(),
            started,
            "Falha não consome o início do preenchimento",
          );
          const saved = (await save(revised, "draft")).item;
          assert.equal(saved.vehicleId, vehicleId);
          assert.equal(
            saved.payload.vehicleSnapshot.rentalCompany,
            rental.name,
          );
          assert.equal(saved.payload.primaryTechnicianCharged, "Não");
          assert.equal(saved.payload.additionalTechnicians[0].charged, "Sim");
          assert.equal(saved.payload.reasons[0].services[0].completed, "Sim");
          assert.equal(saved.payload.days[0].periods[0].odometerStart, "0");
          assert.equal(saved.payload.days[0].periods[0].odometerEnd, "N/A");
          assert.equal(
            saved.payload.technicianSignature.signerName,
            resignTech.signerName,
          );
          assert.equal(
            saved.payload.technicianSignature.createdAt,
            resignTech.createdAt,
          );
          assert.equal(
            saved.payload.clientSignature.createdAt,
            signClient.createdAt,
          );
          assert.equal(await startQuery(), undefined);
          const timestamps = async () =>
            (
              await pool.query(
                "SELECT filling_started_at,created_at,updated_at FROM service_orders WHERE id=$1",
                [recordId],
              )
            ).rows[0];
          const before = await timestamps();
          assert.deepEqual(before.filling_started_at, started);
          assert.ok(before.created_at >= before.filling_started_at);
          assert.ok(!("fillingStartedAt" in saved));
          const finish = {
            ...body,
            baseVersion: 1,
            mutationId: crypto.randomUUID(),
          };
          await call(
            url,
            {
              ...finish,
              date: input.date,
              payload: { ...revised, formRevision: undefined },
            },
            "PUT",
            428,
          );
          const finalized = (await call(url, finish, "PUT")).item;
          assert.equal(finalized.status, "finalized");
          assert.equal(finalized.date, saved.date);
          const after = await timestamps();
          assert.deepEqual(after.created_at, before.created_at);
          assert.deepEqual(after.filling_started_at, before.filling_started_at);
          assert.ok(after.updated_at > before.updated_at);
          const pdf = await fetch(base + url + "/document/pdf", {
            headers: { Authorization: "Bearer " + token },
          });
          assert.equal(pdf.status, 200);
          assert.match(
            pdf.headers.get("content-disposition")!,
            new RegExp("Cliente-teste-" + tag + "-OMIE-" + tag + "\\.pdf"),
          );
          assert.equal(
            Buffer.from(await pdf.arrayBuffer())
              .subarray(0, 4)
              .toString(),
            "%PDF",
          );
        },
      );
      // Independent schedules, linked hours and carpooling must survive a real save/reload.
      const peopleId = crypto.randomUUID();
      const personDay = {
        ...day,
        notes: "Trânsito intenso na BR-381",
        participants: [
          {
            technicianId: techId,
            present: true,
            sameHoursAs: null,
            sameVehicleAs: null,
            odometerStart: "100",
            odometerEnd: "125",
            periods: day.periods,
          },
          {
            technicianId: tech2,
            present: true,
            sameHoursAs: techId,
            sameVehicleAs: techId,
            odometerStart: "",
            odometerEnd: "",
            periods: [],
          },
          {
            technicianId: aux,
            present: false,
            sameHoursAs: null,
            sameVehicleAs: null,
            odometerStart: "",
            odometerEnd: "",
            periods: [],
          },
        ],
      };
      const peopleInput = {
        ...input,
        number: "PEOPLE-" + tag,
        mutationId: crypto.randomUUID(),
        payload: { ...p, days: [personDay] },
      };
      await call("/api/reports/" + peopleId, peopleInput, "PUT");
      const reloaded = (await call("/api/reports/" + peopleId)).item;
      assert.deepEqual(
        reloaded.payload.days[0].participants,
        personDay.participants,
      );
      assert.equal(reloaded.payload.days[0].notes, personDay.notes);
      assert.deepEqual(dayTotals(reloaded.payload.days[0]), {
        work: 1050,
        travel: 330,
        km: 25,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM service_order_day_participants WHERE service_order_id=$1",
            [peopleId],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM service_order_participant_periods WHERE service_order_id=$1",
            [peopleId],
          )
        ).rows[0].n,
        6,
      );
      personDay.participants[1].sameHoursAs = null;
      personDay.participants[1].periods = [
        {
          id: "independent",
          kind: "work",
          start: "10:00",
          end: "12:00",
          pauseMinutes: "15",
        },
      ];
      const independent = await call(
        "/api/reports/" + peopleId,
        { ...peopleInput, baseVersion: 1, mutationId: crypto.randomUUID() },
        "PUT",
      );
      assert.deepEqual(dayTotals(independent.item.payload.days[0]), {
        work: 630,
        travel: 330,
        km: 25,
      });
      // Main technician need not attend this date: only the second professional works.
      personDay.participants[0].present = false;
      personDay.participants[1].sameVehicleAs = null;
      personDay.participants[1].odometerStart = "20";
      personDay.participants[1].odometerEnd = "30";
      const onlySecond = await call(
        "/api/reports/" + peopleId,
        { ...peopleInput, baseVersion: 2, mutationId: crypto.randomUUID() },
        "PUT",
      );
      assert.deepEqual(dayTotals(onlySecond.item.payload.days[0]), {
        work: 105,
        travel: 0,
        km: 10,
      });
      for (const mutate of [
        (d: any) => {
          d.participants[1].sameHoursAs = techId;
        }, // absent reference
        (d: any) => {
          d.participants[1].sameVehicleAs = tech2;
        }, // self-reference
        (d: any) => {
          d.participants[1].technicianId = "not-in-team";
        },
        (d: any) => {
          d.participants.push(d.participants[1]);
        },
        (d: any) => {
          d.participants[1].present = false;
        },
        (d: any) => {
          d.participants[1].periods = [];
        },
      ]) {
        const bad = structuredClone(peopleInput);
        mutate(bad.payload.days[0]);
        await call(
          "/api/reports/" + peopleId,
          { ...bad, baseVersion: 3, mutationId: crypto.randomUUID() },
          "PUT",
          422,
        );
      }
      assert.equal(first.item.version, 1);
      assert.equal(first.item.payload.days.length, 1);
      assert.deepEqual(first.item.payload.days[0].periods, day.periods);
      assert.deepEqual(dayTotals(first.item.payload.days[0]), {
        work: 525,
        travel: 165,
        km: 0,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM service_order_day_periods WHERE service_order_id=$1",
            [id],
          )
        ).rows[0].n,
        6,
      );
      assert.equal(first.item.payload.days[0].hourmeterLower, "301");
      assert.equal(first.item.payload.days[0].hourmeterUpper, "N/A");
      assert.equal(first.item.payload.equipment.hourmeterLower, "300");
      assert.equal(first.item.payload.equipment.hourmeterUpper, "N/A");
      assert.deepEqual(
        first.item.payload.additionalTechnicians,
        p.additionalTechnicians,
      );
      assert.deepEqual(first.item.payload.auxiliaries, [aux]);
      assert.deepEqual(
        first.item.payload.teamSnapshot.map((m: any) => [m.name, m.role]),
        [
          ["Técnico teste", "technician"],
          ["Segundo técnico", "technician"],
          ["Auxiliar da equipe", "auxiliary"],
        ],
      );
      for (const member of [techId, tech2, aux]) {
        assert.ok(
          (await call("/api/reports?technicianId=" + member)).items.some(
            (r: any) => r.id === id,
          ),
        );
      }
      assert.ok(
        (
          await call("/api/reports?q=" + encodeURIComponent("Segundo técnico"))
        ).items.some((r: any) => r.id === id),
      );
      for (const invalid of [
        [{ technicianId: techId, role: "auxiliary" }],
        [
          { technicianId: tech2, role: "technician" },
          { technicianId: tech2, role: "auxiliary" },
        ],
        [{ technicianId: "missing-person", role: "technician" }],
        [{ technicianId: aux, role: "admin" }],
        [{ technicianId: "", role: "technician" }],
      ]) {
        await call(
          "/api/reports/" + crypto.randomUUID(),
          {
            ...input,
            number: crypto.randomUUID(),
            mutationId: crypto.randomUUID(),
            payload: { ...p, additionalTechnicians: invalid },
          },
          "PUT",
          422,
        );
      }
      const retry = await call("/api/reports/" + id, input, "PUT");
      assert.equal(retry.item.version, 1);
      await call(
        "/api/reports/" + id,
        { ...input, number: "changed" },
        "PUT",
        409,
      );
      await call(
        "/api/reports/" + id,
        { ...input, mutationId: crypto.randomUUID() },
        "PUT",
        409,
      );
      await call(
        "/api/reports/" + crypto.randomUUID(),
        { ...input, mutationId: crypto.randomUUID() },
        "PUT",
        409,
      );
      const update = {
        ...input,
        baseVersion: 1,
        mutationId: crypto.randomUUID(),
      };
      const concurrent = await Promise.all([
        fetch(base + "/api/reports/" + id, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-BRLIFT-Database": databaseId,
            "X-BRLIFT-Contract": "4",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify(update),
        }),
        fetch(base + "/api/reports/" + id, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-BRLIFT-Database": databaseId,
            "X-BRLIFT-Contract": "4",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ ...update, mutationId: crypto.randomUUID() }),
        }),
      ]);
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      const list = await call(
        "/api/reports?clientId=" +
          clientId +
          "&status=finalized&from=2026-09-01&to=2026-09-30",
      );
      assert.equal(list.items.length, 2);
      assert.deepEqual(
        new Set(list.items.map((r: any) => r.id)),
        new Set([id, peopleId]),
      );
      const legacyId = crypto.randomUUID(),
        legacyPayload = { ...p, auxiliaries: [aux] };
      delete legacyPayload.additionalTechnicians;
      const legacy = await call(
        "/api/reports/" + legacyId,
        {
          ...input,
          status: "draft",
          number: "LEGACY-" + tag,
          mutationId: crypto.randomUUID(),
          payload: legacyPayload,
        },
        "PUT",
      );
      assert.deepEqual(legacy.item.payload.additionalTechnicians, [
        { technicianId: aux, role: "auxiliary" },
      ]);
      // A person already in a historical team remains usable after catalog deactivation.
      await call(
        "/api/catalog/technicians/" + aux,
        { baseVersion: 1 },
        "DELETE",
      );
      const promoted = await call(
        "/api/reports/" + legacyId,
        {
          ...input,
          status: "draft",
          number: "LEGACY-" + tag,
          technicianId: aux,
          baseVersion: 1,
          mutationId: crypto.randomUUID(),
          payload: { ...p, additionalTechnicians: [], auxiliaries: [] },
        },
        "PUT",
      );
      assert.equal(promoted.item.payload.teamSnapshot[0].role, "technician");
      assert.equal(promoted.item.payload.teamSnapshot[0].technicianId, aux);
      const inspectionId = crypto.randomUUID(),
        sections = createTemplateSections();
      for (const s of sections) for (const i of s.items) i.situation = "A";
      sections[0].items[0].images = [
        { ...media, createdAt: new Date().toISOString() },
      ];
      const insp = {
        id: inspectionId,
        name: "Teste",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        documentFields: Object.fromEntries(
          documentFields.map((f) => [
            f.key,
            (
              {
                "005": "2020",
                "006": "100.5",
                "007": "0",
                "010": "28/09/2026",
                "012": "28/09/2027",
              } as Record<string, string>
            )[f.key] ?? "Teste " + f.key,
          ]),
        ),
        documentImages: { "013": [media] },
        sections,
        signature: media,
      };
      await scenario(
        "inspeção atualizada persiste cronograma de um técnico e as três leituras",
        async () => {
          const recordId = crypto.randomUUID();
          const url = "/api/inspections/" + recordId;
          await call(url + "/filling-start", {}, "POST", 204);
          const payload = {
            ...structuredClone(insp),
            id: recordId,
            signature: undefined,
            formRevision: 2,
            technicianSignature: await uploadSignature(
              "inspections",
              recordId,
              "technician",
              "INSPETOR QA",
            ),
            clientSignature: await uploadSignature(
              "inspections",
              recordId,
              "client",
              "CLIENTE DA INSPEÇÃO",
            ),
            documentFields: {
              ...insp.documentFields,
              "011": "Rejeitada",
              "006": "0",
              hourmeterUpper: "N/A",
              "007": "101",
              equipmentBrand: "MARCA HISTÓRICA",
              equipmentPlate: "XYZ9A87",
              equipmentFleet: "FROTA-42",
            },
            approvedByTechnicianId: tech2,
            days: [
              {
                ...newDay("inspection-day"),
                notes: "FISCALIZAÇÃO EM CAMPO",
                periods: [
                  {
                    id: "inspection-travel",
                    kind: "outbound",
                    start: "07:00",
                    end: "08:00",
                    pauseMinutes: "",
                    odometerStart: "80",
                    odometerEnd: "101",
                  },
                  {
                    id: "inspection-work",
                    kind: "work",
                    start: "08:00",
                    end: "10:00",
                    pauseMinutes: "10",
                    odometerStart: "N/A",
                    odometerEnd: "N/A",
                  },
                ],
              },
            ],
          };
          const body = {
            ...input,
            date: undefined,
            vehicleId,
            number: "IN-OMIE-" + tag,
            payload,
            mutationId: crypto.randomUUID(),
          };
          const missingKm = structuredClone(body);
          missingKm.payload.days[0].periods[0].odometerStart = "";
          await call(url, missingKm, "PUT", 422);
          const backwardsTime = structuredClone(body);
          backwardsTime.payload.days[0].periods[1].start = "07:59";
          await call(url, backwardsTime, "PUT", 422);
          const backwardsKm = structuredClone(body);
          Object.assign(backwardsKm.payload.days[0].periods[1], {
            odometerStart: "5",
            odometerEnd: "6",
          });
          await call(url, backwardsKm, "PUT", 422);
          const saved = (await call(url, body, "PUT")).item;
          const reloaded = (await call(url)).item;
          assert.deepEqual(reloaded, saved);
          assert.equal(reloaded.payload.days[0].participants, undefined);
          assert.deepEqual(dayTotals(reloaded.payload.days[0]), {
            work: 110,
            travel: 60,
            km: 21,
          });
          assert.equal(reloaded.payload.documentFields.hourmeterUpper, "N/A");
          assert.equal(reloaded.payload.documentFields["006"], "0");
          assert.equal(reloaded.payload.documentFields["007"], "101");
          assert.equal(reloaded.payload.documentFields["011"], "Rejeitada");
          assert.equal(
            reloaded.payload.documentFields.equipmentBrand,
            "MARCA HISTÓRICA",
          );
          assert.equal(
            reloaded.payload.documentFields.equipmentPlate,
            "XYZ9A87",
          );
          assert.equal(
            reloaded.payload.documentFields.equipmentFleet,
            "FROTA-42",
          );
          const compatiblePayload = structuredClone(reloaded.payload);
          for (const key of [
            "equipmentBrand",
            "equipmentPlate",
            "equipmentFleet",
          ])
            delete compatiblePayload.documentFields[key];
          const compatibleSave = (
            await call(
              url,
              {
                ...body,
                payload: compatiblePayload,
                baseVersion: reloaded.version,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
            )
          ).item;
          for (const key of [
            "equipmentBrand",
            "equipmentPlate",
            "equipmentFleet",
          ])
            assert.equal(
              compatibleSave.payload.documentFields[key],
              reloaded.payload.documentFields[key],
            );
          assert.equal(reloaded.payload.approvedByTechnicianId, tech2);
          assert.equal(
            reloaded.payload.technicianSignature.signerName,
            "INSPETOR QA",
          );
          assert.equal(
            reloaded.payload.clientSignature.signerName,
            "CLIENTE DA INSPEÇÃO",
          );
        },
      );
      const extraSlot = sections
        .flatMap((s) => s.items)
        .find((i) => i.extraImageSlots?.length)?.extraImageSlots?.[0];
      assert.ok(extraSlot);
      (insp.documentImages as Record<string, any[]>)[extraSlot] = [media];
      await call(
        "/api/inspections/" + inspectionId,
        {
          ...input,
          number: "IN-" + tag,
          payload: insp,
          mutationId: crypto.randomUUID(),
        },
        "PUT",
      );
      await fs.mkdir("tests-output", { recursive: true });
      for (const [kind, entryId, formats] of [
        ["reports", id, ["pdf"]],
        [
          "inspections",
          inspectionId,
          process.env.TEST_PDF ? ["docx", "pdf"] : ["docx"],
        ],
      ] as const) {
        for (const format of formats) {
          const result = await fetch(
            base + "/api/" + kind + "/" + entryId + "/document/" + format,
            { headers: { Authorization: "Bearer " + token } },
          );
          assert.equal(result.status, 200, await result.clone().text());
          const buffer = Buffer.from(await result.arrayBuffer());
          assert.ok(buffer.length > 1000);
          if (format === "pdf")
            assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
          await fs.writeFile(
            path.resolve("tests-output/" + kind + "." + format),
            buffer,
          );
        }
      }
      await scenario(
        "entidades tipadas sem JSON de negócio, checklist completo e arquivos vinculados",
        async () => {
          const json = (
            await pool.query(
              "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND data_type IN ('json','jsonb') ORDER BY table_name",
            )
          ).rows.map((r) => r.table_name);
          assert.deepEqual(json, ["audit", "audit", "sync_receipts"]);
          assert.equal(
            (
              await pool.query(
                "SELECT to_regclass('public.catalog') c,to_regclass('public.records') r",
              )
            ).rows[0].c,
            null,
          );
          assert.equal(
            (await pool.query("SELECT to_regclass('public.records') r")).rows[0]
              .r,
            null,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT count(*) FROM inspection_items WHERE inspection_id=$1",
                  [inspectionId],
                )
              ).rows[0].count,
            ),
            141,
          );
          const files = (
            await pool.query(
              "SELECT purpose FROM inspection_files WHERE inspection_id=$1 ORDER BY purpose",
              [inspectionId],
            )
          ).rows.map((r) => r.purpose);
          assert.deepEqual(files, [
            "equipment_photo",
            "extra_photo",
            "item_photo",
            "signature",
          ]);
          const remote = (await call("/api/inspections/" + inspectionId)).item;
          assert.equal(remote.payload.documentImages[extraSlot][0].width, 900);
          assert.equal(
            remote.payload.sections[0].items[0].images[0].height,
            450,
          );
          assert.equal(remote.payload.documentFields["010"], "28/09/2026");
          assert.equal(remote.payload.documentFields["007"], "0");
          const completedInspection = await call(
            "/api/inspections/" + inspectionId,
            {
              ...remote,
              status: "finalized",
              baseVersion: remote.version,
              mutationId: crypto.randomUUID(),
              payload: {
                ...remote.payload,
                approvedByTechnicianId: techId,
                technicianSignature: media,
                documentFields: {
                  ...remote.payload.documentFields,
                  "011": "Aprovada",
                },
              },
            },
            "PUT",
          );
          assert.equal(
            completedInspection.item.payload.documentFields["009"],
            completedInspection.item.payload.documentFields["164"],
          );
          assert.equal(
            completedInspection.item.payload.documentFields["011"],
            "Aprovada",
          );
          assert.equal(
            completedInspection.item.payload.approvedByTechnicianId,
            techId,
          );
          assert.ok(completedInspection.item.payload.technicianSignature?.uri);
          assert.ok(completedInspection.item.payload.clientSignature?.uri);
          const signerFiles = (
            await pool.query(
              "SELECT purpose FROM inspection_files WHERE inspection_id=$1 AND purpose IN ('technician_signature','client_signature') ORDER BY purpose",
              [inspectionId],
            )
          ).rows.map((row) => row.purpose);
          assert.deepEqual(signerFiles, [
            "client_signature",
            "technician_signature",
          ]);
          const typed = (
            await pool.query(
              "SELECT odometer,hourmeter_upper,hourmeter_upper_not_applicable FROM service_orders WHERE id=$1",
              [id],
            )
          ).rows[0];
          assert.equal(Number(typed.odometer), 100);
          assert.equal(typed.hourmeter_upper, null);
          assert.equal(typed.hourmeter_upper_not_applicable, true);
          const used = (
            await pool.query(
              "SELECT quantity,part_id FROM service_order_parts WHERE service_order_id=$1",
              [id],
            )
          ).rows[0];
          assert.equal(Number(used.quantity), 2.5);
          assert.equal(used.part_id, partId);
        },
      );
      await scenario(
        "transação desfaz cabeçalho e filhos quando um item falha",
        async () => {
          const before = (await call("/api/reports/" + id)).item;
          const auditCount = (
            await pool.query("SELECT count(*) FROM audit WHERE entity_id=$1", [
              id,
            ])
          ).rows[0].count;
          await call(
            "/api/reports/" + id,
            {
              ...before,
              baseVersion: before.version,
              mutationId: crypto.randomUUID(),
              number: "ROLLBACK-" + tag,
              payload: {
                ...before.payload,
                parts: [
                  { ...before.payload.parts[0], catalogId: "inexistente" },
                ],
              },
            },
            "PUT",
            422,
          );
          assert.deepEqual((await call("/api/reports/" + id)).item, before);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM audit WHERE entity_id=$1",
                [id],
              )
            ).rows[0].count,
            auditCount,
          );
        },
      );
      await scenario(
        "FKs impedem entidade errada e equipamento de outro cliente; primeiro auxiliar é permitido",
        async () => {
          await assert.rejects(
            () =>
              pool.query("UPDATE inspections SET client_id=$1 WHERE id=$2", [
                techId,
                inspectionId,
              ]),
            { code: "23503" },
          );
          const other = crypto.randomUUID();
          await call(
            "/api/catalog/clients/" + other,
            { name: "Outro cliente", identifier: "999" + doc, baseVersion: 0 },
            "PUT",
          );
          await assert.rejects(
            () =>
              pool.query("UPDATE inspections SET client_id=$1 WHERE id=$2", [
                other,
                inspectionId,
              ]),
            { code: "23503" },
          );
          await call(
            "/api/inspections/" + crypto.randomUUID(),
            {
              ...input,
              number: crypto.randomUUID(),
              clientId: other,
              payload: insp,
              mutationId: crypto.randomUUID(),
            },
            "PUT",
            422,
          );
          await pool.query(
            "UPDATE service_order_team SET role='auxiliary' WHERE service_order_id=$1 AND position=0",
            [id],
          );
          const auxiliaryReport = await call("/api/reports/" + id);
          assert.equal(
            auxiliaryReport.item.payload.primaryTechnicianRole,
            "auxiliary",
          );
          assert.equal(
            auxiliaryReport.item.payload.teamSnapshot[0].role,
            "auxiliary",
          );
          await assert.rejects(
            () =>
              transaction(async (db) => {
                await db.query(
                  "DELETE FROM service_order_team WHERE service_order_id=$1 AND position=0",
                  [id],
                );
              }),
            { code: "23514" },
          );
        },
      );
      await scenario(
        "cadastro atual é refletido por ID; histórico de peças e dados operacionais são preservados",
        async () => {
          const before = (await call("/api/reports/" + id)).item;
          const currentCpf = doc.startsWith("7")
            ? "8" + doc.slice(1)
            : "7" + doc.slice(1);
          const currentCnpj = "888" + doc;
          await call(
            "/api/catalog/clients/" + clientId,
            {
              name: "Cliente renomeado",
              identifier: currentCnpj,
              baseVersion: 1,
            },
            "PUT",
          );
          await call(
            "/api/catalog/technicians/" + techId,
            {
              name: "Técnico renomeado",
              identifier: currentCpf,
              baseVersion: 1,
            },
            "PUT",
          );
          await call(
            "/api/catalog/parts/" + partId,
            {
              name: "Nova descrição",
              identifier: "FINAL-" + tag,
              baseVersion: 2,
            },
            "PUT",
          );
          const after = (await call("/api/reports/" + id)).item;
          assert.equal(after.clientName, "Cliente renomeado");
          assert.equal(after.payload.clientSnapshot.identifier, currentCnpj);
          assert.equal(after.payload.teamSnapshot[0].identifier, currentCpf);
          assert.equal(
            (await call("/api/inspections/" + inspectionId)).item.payload
              .technicianSnapshot.identifier,
            currentCpf,
          );
          assert.equal(after.payload.teamSnapshot[0].name, "Técnico renomeado");
          assert.deepEqual(after.payload.parts, before.payload.parts);
          assert.deepEqual(after.payload.days, before.payload.days);
          const saved = await call(
            "/api/reports/" + id,
            {
              ...after,
              baseVersion: after.version,
              mutationId: crypto.randomUUID(),
            },
            "PUT",
          );
          assert.equal(saved.item.clientName, "Cliente renomeado");
          assert.deepEqual(
            saved.item.payload.teamSnapshot,
            after.payload.teamSnapshot,
          );
          assert.deepEqual(saved.item.payload.parts, before.payload.parts);
          assert.equal(saved.item.finalizedAt, before.finalizedAt);
          assert.equal(saved.item.finalizedBy, tag);
          const original = (await call("/api/inspections/" + inspectionId))
            .item;
          const updated = await call(
            "/api/inspections/" + inspectionId,
            {
              ...original,
              baseVersion: original.version,
              mutationId: crypto.randomUUID(),
            },
            "PUT",
          );
          assert.equal(
            updated.item.payload.finalizedAt,
            original.payload.finalizedAt,
          );
        },
      );
      await scenario(
        "datas e leituras inválidas são rejeitadas sem registro parcial",
        async () => {
          for (const [key, value] of [
            ["005", "abc"],
            ["006", "-1"],
            ["007", "NaN"],
            ["010", "31/02/2026"],
          ]) {
            await call(
              "/api/inspections/" + crypto.randomUUID(),
              {
                ...input,
                number: crypto.randomUUID(),
                mutationId: crypto.randomUUID(),
                payload: {
                  ...insp,
                  documentFields: { ...insp.documentFields, [key]: value },
                },
              },
              "PUT",
              422,
            );
          }
        },
      );
      await scenario(
        "cliente antigo ou de outra instalação não pode gravar",
        async () => {
          for (const headers of [
            {},
            {
              "X-BRLIFT-Database": crypto.randomUUID(),
              "X-BRLIFT-Contract": "4",
            },
          ] as Record<string, string>[]) {
            const res = await fetch(
              base + "/api/catalog/clients/" + crypto.randomUUID(),
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer " + token,
                  ...headers,
                },
                body: JSON.stringify({
                  name: "Não salvar",
                  identifier: "000" + doc,
                  baseVersion: 0,
                }),
              },
            );
            assert.equal(res.status, 428);
            assert.equal(
              (await res.json()).code,
              headers["X-BRLIFT-Contract"] === "4"
                ? "DATABASE_CHANGED"
                : "CLIENT_OUTDATED",
            );
          }
        },
      );
      await scenario(
        "técnico só consulta e altera atendimentos e inspeções próprios",
        async () => {
          const ownTechnicianId = registered.technician.id;
          const auxiliaryReportId = crypto.randomUUID();
          await call(
            "/api/reports/" + auxiliaryReportId,
            {
              ...input,
              number: "AUX-" + tag,
              status: "draft",
              payload: {
                ...newReport(),
                additionalTechnicians: [
                  { technicianId: ownTechnicianId, role: "auxiliary" },
                ],
              },
              mutationId: crypto.randomUUID(),
            },
            "PUT",
          );
          assert.ok(
            (await call("/api/reports")).items.some(
              (row: any) => row.id === id,
            ),
          );
          const ownLogin = await call(
            "/api/auth/login",
            { email: newProfileEmail, password: newProfilePassword },
            "POST",
          );
          const adminToken = token;
          token = ownLogin.token;
          try {
            const ownReportId = crypto.randomUUID();
            const ownReportInput = {
              ...input,
              number: "SELF-" + tag,
              technicianId: ownTechnicianId,
              status: "draft",
              payload: newReport(),
              mutationId: crypto.randomUUID(),
            };
            const ownReport = await call(
              "/api/reports/" + ownReportId,
              ownReportInput,
              "PUT",
            );
            assert.equal(ownReport.item.technicianId, ownTechnicianId);
            const ownInspectionId = crypto.randomUUID();
            const ownInspection = await call(
              "/api/inspections/" + ownInspectionId,
              {
                number: "SELF-IN-" + tag,
                clientId,
                technicianId: ownTechnicianId,
                equipmentId: eqId,
                date: "2026-09-26",
                status: "draft",
                payload: {
                  documentFields: Object.fromEntries(
                    documentFields.map((field) => [field.key, ""]),
                  ),
                  documentImages: {},
                  sections: createTemplateSections(),
                },
                baseVersion: 0,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
            );
            assert.equal(ownInspection.item.technicianId, ownTechnicianId);
            const reports = (await call("/api/reports")).items;
            assert.ok(reports.some((row: any) => row.id === ownReportId));
            assert.ok(reports.some((row: any) => row.id === auxiliaryReportId));
            assert.ok(!reports.some((row: any) => row.id === id));
            const teamReport = (await call("/api/reports/" + auxiliaryReportId))
              .item;
            const teamEdit = await call(
              "/api/reports/" + auxiliaryReportId,
              {
                ...teamReport,
                baseVersion: teamReport.version,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
            );
            assert.equal(teamEdit.item.id, auxiliaryReportId);
            await call(
              "/api/reports/" + ownReportId,
              {
                ...ownReport.item,
                baseVersion: ownReport.item.version,
                mutationId: crypto.randomUUID(),
                payload: {
                  ...ownReport.item.payload,
                  technicianSignature: media,
                },
              },
              "PUT",
              422,
            );
            const forgedFilter = (
              await call("/api/reports?technicianId=" + techId)
            ).items;
            assert.ok(forgedFilter.some((row: any) => row.id === ownReportId));
            assert.ok(!forgedFilter.some((row: any) => row.id === id));
            assert.equal(
              (
                await call(
                  "/api/reports?q=" + encodeURIComponent("Técnico teste"),
                )
              ).items.length,
              0,
            );
            const inspections = (await call("/api/inspections")).items;
            assert.ok(
              inspections.some((row: any) => row.id === ownInspectionId),
            );
            assert.ok(!inspections.some((row: any) => row.id === inspectionId));
            await call("/api/reports/" + id, undefined, "GET", 404);
            await call(
              "/api/inspections/" + inspectionId,
              undefined,
              "GET",
              404,
            );
            await call(
              "/api/reports/" + id + "/document/pdf",
              undefined,
              "GET",
              404,
            );
            await call("/api/media/" + media.id, undefined, "GET", 404);
            await call(
              "/api/reports/" + id,
              { ...input, mutationId: crypto.randomUUID() },
              "PUT",
              404,
            );
            await call(
              "/api/reports/" + crypto.randomUUID(),
              {
                ...ownReportInput,
                technicianId: techId,
                number: "OTHER-" + tag,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
              403,
            );
            await call(
              "/api/reports/" + ownReportId,
              {
                ...ownReportInput,
                technicianId: techId,
                baseVersion: ownReport.item.version,
                mutationId: crypto.randomUUID(),
              },
              "PUT",
              403,
            );
            await call(
              "/api/inspections/" + inspectionId,
              {
                ...ownInspection.item,
                mutationId: crypto.randomUUID(),
                baseVersion: ownInspection.item.version,
              },
              "PUT",
              404,
            );
            assert.equal(
              (await call("/api/reports/" + ownReportId)).item.id,
              ownReportId,
            );
            assert.equal(
              (await call("/api/inspections/" + ownInspectionId)).item.id,
              ownInspectionId,
            );
          } finally {
            token = adminToken;
          }
        },
      );
      await call(
        "/api/catalog/clients/" + clientId,
        { baseVersion: 2 },
        "DELETE",
      );
      assert.equal((await call("/api/reports/" + id)).item.clientId, clientId);
      await call("/api/auth/logout", {});
      await call("/api/auth/me", undefined, "GET", 401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    }
  },
);
