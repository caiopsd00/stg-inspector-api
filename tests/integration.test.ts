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
    const tag = crypto.randomUUID(),
      email = tag + "@example.test",
      password = crypto.randomBytes(16).toString("hex");
    const userCpf = tag.replace(/\D/g, "").padEnd(11, "0").slice(0, 11);
    await assert.rejects(
      pool.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'Sem técnico',$3,'admin')",
        [crypto.randomUUID(), "orphan-" + tag + "@example.test", "hash"],
      ),
      /precisa ter um cadastro de técnico vinculado/,
    );
    await transaction(async (db) => {
      await db.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'Usuário de teste',$3,'admin')",
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
      const value = await res.json();
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
          role: "admin",
        },
        "PUT",
      );
      assert.equal(edited.technician.identifier, editedCpf);
      assert.equal(
        (await call("/api/auth/me")).user.name,
        "Usuário atualizado " + tag,
      );
      await call(`/api/users/${tag}/active`, { active: false }, "PUT", 409);
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
      const first = await call("/api/reports/" + id, input, "PUT");
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
        "FKs impedem entidade errada, equipamento de outro cliente e primeiro auxiliar",
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
          await assert.rejects(
            () =>
              pool.query(
                "UPDATE service_order_team SET role='auxiliary' WHERE service_order_id=$1 AND position=0",
                [id],
              ),
            { code: "23514" },
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
        "renomear cadastros não altera snapshots nem PDF histórico",
        async () => {
          const before = (await call("/api/reports/" + id)).item;
          await call(
            "/api/catalog/clients/" + clientId,
            {
              name: "Cliente renomeado",
              identifier: "123" + doc,
              baseVersion: 1,
            },
            "PUT",
          );
          await call(
            "/api/catalog/technicians/" + techId,
            { name: "Técnico renomeado", identifier: doc, baseVersion: 1 },
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
          assert.deepEqual(after, before);
          const saved = await call(
            "/api/reports/" + id,
            {
              ...after,
              baseVersion: after.version,
              mutationId: crypto.randomUUID(),
            },
            "PUT",
          );
          assert.equal(saved.item.clientName, before.clientName);
          assert.deepEqual(
            saved.item.payload.teamSnapshot,
            before.payload.teamSnapshot,
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
