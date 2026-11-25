import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";
import { createApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { pool } from "../server/db.js";
import { createUserAndTechnician } from "../server/users.js";
import { newReport } from "../contracts/domain.js";
import { createTemplateSections } from "../contracts/inspection-template.js";

test(
  "permissões reais de cadastro, delegação e equipe, inclusive chamadas diretas e concorrentes",
  { skip: !process.env.DATABASE_URL, timeout: 120000 },
  async () => {
    if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
      throw Error("Use somente o banco isolado brlift_test.");
    await migrate();
    const password = crypto.randomBytes(20).toString("hex");
    const accounts = [];
    for (const role of [
      "admin",
      "technician",
      "technician",
      "technician_admin",
    ] as const) {
      accounts.push(
        await createUserAndTechnician({
          name: `Permissões ${role}`,
          email: `${crypto.randomUUID()}@example.test`,
          password,
          role,
          cpf:
            role === "admin"
              ? ""
              : String(crypto.randomInt(10_000_000_000, 99_999_999_999)),
        }),
      );
    }
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    let databaseId = "";
    async function call(
      token: string,
      url: string,
      body?: any,
      method = body ? "PUT" : "GET",
      status = 200,
    ) {
      const res = await fetch(base + "/api" + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          "X-BRLIFT-Database": databaseId,
          "X-BRLIFT-Contract": "4",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = res.headers.get("content-type")?.includes("json")
        ? await res.json()
        : await res.arrayBuffer();
      assert.equal(
        res.status,
        status,
        `${method} ${url}: ${JSON.stringify(value)}`,
      );
      return value as any;
    }
    try {
      const tokens: string[] = [];
      for (const account of accounts) {
        const login = await call(
          "",
          "/auth/login",
          { email: account.user.email, password },
          "POST",
        );
        databaseId = login.databaseId;
        tokens.push(login.token);
      }
      const [admin, tech, other, hybrid] = tokens;
      const uuid = () => crypto.randomUUID();
      const make = async (kind: string, token = admin) => {
        const id = uuid();
        const data: any = {
          name: `Cadastro ${id}`,
          identifier: uuid().replaceAll("-", ""),
          baseVersion: 0,
          mutationId: uuid(),
        };
        if (kind === "clients")
          data.identifier = String(
            crypto.randomInt(10_000_000_000_000, 99_999_999_999_999),
          );
        if (kind === "equipment") {
          data.clientId = client.id;
          data.data = {
            type: "Guindaste",
            brand: "Teste",
            model: "Modelo",
            serial: uuid(),
            year: "2020",
            plate: "N/A",
            fleet: "N/A",
          };
        }
        if (kind === "vehicles") {
          data.identifier = id.replaceAll("-", "").slice(0, 12);
          data.data = { rentalCompanyId: rental.id };
        }
        const saved = (await call(token, `/catalog/${kind}/${id}`, data)).item;
        return { ...saved, request: data };
      };
      const client = await make("clients");
      const rental = await make("rentalCompanies");
      const equipment = await make("equipment");
      for (const kind of [
        "clients",
        "equipment",
        "parts",
        "vehicles",
        "rentalCompanies",
      ]) {
        const foreign = await make(kind, other);
        const first = await make(kind, tech);
        const firstUrl = `/catalog/${kind}/${first.id}`;
        assert.equal(first.permissions.edit, true);
        await call(tech, firstUrl, {
          ...first.request,
          name: "Primeiro corrigido",
          baseVersion: 1,
          mutationId: uuid(),
        });
        const second = await make(kind, tech);
        const denied = {
          ...first.request,
          baseVersion: 2,
          mutationId: uuid(),
          permissions: { edit: true },
        };
        await call(tech, firstUrl, denied, "PUT", 403);
        // Replaying an old mutation does not bypass the now-revoked grant.
        await call(tech, firstUrl, first.request, "PUT", 403);
        await call(
          tech,
          `/catalog/${kind}/${foreign.id}`,
          { ...foreign.request, baseVersion: 1, mutationId: uuid() },
          "PUT",
          403,
        );
        await call(
          tech,
          `/catalog/${kind}/${second.id}`,
          { baseVersion: 1 },
          "DELETE",
          403,
        );
        const items = (await call(tech, `/catalog/${kind}`)).items;
        assert.equal(
          items.find((i: any) => i.id === first.id).permissions.edit,
          false,
        );
        assert.equal(
          items.find((i: any) => i.id === second.id).permissions.edit,
          true,
        );
        assert.ok(items.every((i: any) => !i.permissions.archive));
        if (kind === "parts")
          assert.equal(
            (await call(tech, "/parts/by-code/" + second.identifier)).item
              .permissions.edit,
            true,
          );
        // Repeated edits do not change which item was most recently CREATED.
        await call(tech, `/catalog/${kind}/${second.id}`, {
          ...second.request,
          baseVersion: 1,
          mutationId: uuid(),
        });
        await call(hybrid, firstUrl, {
          ...first.request,
          baseVersion: 2,
          mutationId: uuid(),
        });
        await call(
          admin,
          `/catalog/${kind}/${second.id}`,
          { baseVersion: 2 },
          "DELETE",
        );
        await call(tech, firstUrl, denied, "PUT", 403); // No fallback to the penultimate item.
        await call(
          tech,
          `/catalog/${kind}/${second.id}`,
          { ...second.request, baseVersion: 3, mutationId: uuid() },
          "PUT",
          403,
        );
      }
      // Concurrent creations leave exactly one editable item of the same type.
      const concurrent = await Promise.all([
        make("clients", tech),
        make("clients", tech),
      ]);
      const rows = (await call(tech, "/catalog/clients")).items;
      assert.equal(
        concurrent.filter(
          (c) => rows.find((i: any) => i.id === c.id).permissions.edit,
        ).length,
        1,
      );
      const lastClient = rows.find((i: any) => i.permissions.edit);
      await make("parts", tech);
      assert.equal(
        (await call(tech, "/catalog/clients")).items.find(
          (i: any) => i.id === lastClient.id,
        ).permissions.edit,
        true,
      );
      const ownTech = accounts[1].technician!.id;
      const otherTech = accounts[2].technician!.id;
      const photo = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#abcdef" },
      })
        .png()
        .toBuffer();
      const media = (
        await call(
          other,
          "/media",
          {
            name: "permissao.png",
            dataUrl: "data:image/png;base64," + photo.toString("base64"),
          },
          "POST",
          201,
        )
      ).media;
      await call(
        tech,
        `/catalog/technicians/${ownTech}`,
        {
          name: "Forjado",
          identifier: accounts[1].technician!.identifier,
          baseVersion: 1,
        },
        "PUT",
        403,
      );
      await call(
        tech,
        `/catalog/technicians/${uuid()}`,
        { name: "Forjado", identifier: "12345678901" },
        "PUT",
        403,
      );
      await call(
        tech,
        `/catalog/technicians/${ownTech}`,
        { baseVersion: 1 },
        "DELETE",
        403,
      );
      const recordInput = (kind: string) => ({
        number: uuid(),
        clientId: client.id,
        equipmentId: equipment.id,
        technicianId: otherTech,
        date: "2026-11-25",
        status: "draft",
        baseVersion: 0,
        mutationId: uuid(),
        payload:
          kind === "reports"
            ? newReport()
            : {
                documentFields: {},
                documentImages: {},
                sections: createTemplateSections(),
                approvedByTechnicianId: ownTech,
              },
      });
      for (const kind of ["reports", "inspections"]) {
        const id = uuid();
        const input = recordInput(kind);
        if (kind === "inspections") {
          // A normal technician acting only as approver can read linked media,
          // but loses that access as soon as the membership is removed.
          (input.payload as any).sections[0].items[0].images = [media];
          await call(other, `/${kind}/${id}`, input);
        }
        const saved =
          kind === "reports"
            ? (await call(tech, `/${kind}/${id}`, input)).item
            : (await call(tech, `/${kind}/${id}`)).item;
        if (kind === "reports") {
          await call(tech, `/${kind}/${id}`, undefined, "GET", 404);
          await call(
            tech,
            `/${kind}/${id}/document/pdf`,
            undefined,
            "GET",
            404,
          );
          await call(tech, `/${kind}/${id}`, input, "PUT", 404);
          assert.ok(
            !(await call(tech, "/reports")).items.some((i: any) => i.id === id),
          );
          assert.ok(
            (await call(other, "/reports")).items.some((i: any) => i.id === id),
          );
          await call(other, `/${kind}/${id}`, {
            ...saved,
            baseVersion: 1,
            mutationId: uuid(),
            payload: {
              ...saved.payload,
              additionalTechnicians: [
                { technicianId: ownTech, role: "auxiliary" },
              ],
            },
          });
          const team = (await call(tech, `/${kind}/${id}`)).item;
          await call(tech, `/${kind}/${id}/document/pdf`);
          await call(tech, `/${kind}/${id}`, {
            ...team,
            baseVersion: team.version,
            mutationId: uuid(),
          });
        } else {
          assert.ok(
            (await call(tech, "/inspections")).items.some(
              (i: any) => i.id === id,
            ),
          );
          const approved = (await call(tech, `/${kind}/${id}`)).item;
          await call(tech, `/${kind}/${id}/document/docx`);
          await call(tech, "/media/" + media.id);
          const removed = (
            await call(tech, `/${kind}/${id}`, {
              ...approved,
              baseVersion: approved.version,
              mutationId: uuid(),
              payload: { ...approved.payload, approvedByTechnicianId: null },
            })
          ).item;
          await call(tech, `/${kind}/${id}`, undefined, "GET", 404);
          await call(tech, "/media/" + media.id, undefined, "GET", 404);
          await call(
            tech,
            `/${kind}/${id}/document/docx`,
            undefined,
            "GET",
            404,
          );
          await call(
            tech,
            `/${kind}/${id}`,
            {
              ...removed,
              baseVersion: removed.version,
              mutationId: uuid(),
              technicianId: ownTech,
            },
            "PUT",
            404,
          );
        }
        assert.equal((await call(other, `/${kind}/${id}`)).item.id, id);
        assert.equal((await call(admin, `/${kind}/${id}`)).item.id, id);
        assert.equal((await call(hybrid, `/${kind}/${id}`)).item.id, id);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  },
);
