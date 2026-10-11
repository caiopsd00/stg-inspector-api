// Isolated end-to-end QA: never creates users or sample data in production.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { chromium } from "playwright";
if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
  throw Error("Defina DATABASE_URL para brlift_test.");
const webRoot = path.resolve(process.env.WEB_REPO || "../stg-system-v2");
const webPort = Number(process.env.E2E_WEB_PORT || 5176);
process.env.WEB_ORIGIN = "http://127.0.0.1:" + webPort;
process.env.STORAGE_DIR = process.env.STORAGE_DIR || "storage-test";
const { pool } = await import("../dist/server/db.js");
const { migrate } = await import("../dist/server/migrate.js");
const { hashPassword } = await import("../dist/server/auth.js");
const { createApp } = await import("../dist/server/app.js");
await migrate();
const tag = crypto.randomUUID().slice(0, 8),
  email = "qa-" + tag + "@example.test",
  password = crypto.randomBytes(18).toString("hex");
await pool.query(
  "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'QA BR LIFT',$3,'admin')",
  [crypto.randomUUID(), email, await hashPassword(password)],
);
const server = createApp().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const vite = spawn(
  process.execPath,
  [
    path.join(webRoot, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
  ],
  {
    cwd: webRoot,
    env: {
      ...process.env,
      API_PROXY_TARGET: "http://127.0.0.1:" + server.address().port,
    },
    stdio: "pipe",
  },
);
let viteLog = "";
vite.stdout.on("data", (c) => (viteLog += c));
vite.stderr.on("data", (c) => (viteLog += c));
let browser;
const output = path.resolve("tests-output/e2e");
await fs.mkdir(output, { recursive: true });
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(process.env.WEB_ORIGIN)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw Error(viteLog);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.E2E_CHROME_CHANNEL
      ? { channel: process.env.E2E_CHROME_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function openSection(...titles) {
    for (const title of titles) {
      const button = page.getByRole("button", { name: title, exact: true });
      if ((await button.getAttribute("aria-expanded")) !== "true")
        await button.click();
    }
    assert.ok(
      (await page
        .locator('[data-main-fold="true"][data-open="true"]')
        .count()) <= 1,
    );
  }
  const teamPath = ["A. Identificação", "Equipe do atendimento"];
  await page.goto(process.env.WEB_ORIGIN);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Novo atendimento", exact: true })
    .click();
  await page
    .getByLabel("Número identificador (único)", { exact: true })
    .fill("QA-AT-" + tag);
  await page
    .getByLabel("Número identificador (único)", { exact: true })
    .press("Tab");
  await page.locator('input[aria-label="Data: dia"]:focus').waitFor();
  assert.equal(
    await page
      .getByLabel("Data: dia", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Data: dia", { exact: true }).press("Escape");
  await openSection("A. Identificação");
  assert.equal(
    await page
      .getByLabel("Número identificador (único)", { exact: true })
      .evaluate((el) => el.closest("section")),
    null,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "A. Identificação", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Identificação do registro", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Cliente", { exact: true })
      .evaluate((el) =>
        el.closest("section")?.querySelector("h2")?.getAttribute("aria-label"),
      ),
    "A. Identificação",
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .isDisabled(),
    true,
  );
  const typeGroup = page.getByRole("group", {
    name: "Tipo de atendimento",
    exact: true,
  });
  await typeGroup
    .getByRole("radio", { name: "Interno (Galpão BR LIFT)", exact: true })
    .check();
  assert.equal(await page.getByLabel("Local", { exact: true }).count(), 0);
  await openSection("E. Cronograma de atendimento");
  await page
    .getByRole("button", { name: "+ Dia de atendimento", exact: true })
    .click();
  assert.equal(await page.getByLabel("KM inicial", { exact: true }).count(), 0);
  assert.equal(
    await page
      .locator("legend")
      .filter({ hasText: "Deslocamento de ida" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Remover dia", exact: true }).click();
  await openSection("A. Identificação");
  await typeGroup.getByRole("radio", { name: "Externo", exact: true }).check();
  // The whole date surface opens the calendar without stealing segment focus.
  const dateGroup = page.getByRole("group", { name: "Data", exact: true });
  await dateGroup.click({ position: { x: 220, y: 20 } });
  const calendar = page.getByRole("dialog", {
    name: "Calendário: Data",
    exact: true,
  });
  await calendar.waitFor();
  await page.getByLabel("Data: dia", { exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Data: dia", { exact: true })
      .evaluate((el) => el.selectionEnd - el.selectionStart),
    2,
  );
  await page.getByLabel("Data: dia", { exact: true }).pressSequentially("02");
  assert.equal(
    await page
      .getByLabel("Data: mês", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Data: mês", { exact: true }).pressSequentially("10");
  assert.equal(
    await page
      .getByLabel("Data: ano", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Data: ano", { exact: true }).pressSequentially("2026");
  await calendar
    .getByRole("button", { name: "03/10/2026", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Data: dia", { exact: true }).inputValue(),
    "03",
  );
  await page
    .getByRole("button", { name: "Abrir calendário: Data", exact: true })
    .click();
  await calendar
    .getByRole("button", { name: "Mês anterior", exact: true })
    .click();
  await calendar
    .getByRole("button", { name: "Próximo mês", exact: true })
    .click();
  await calendar
    .getByRole("button", { name: "02/10/2026", exact: true })
    .click();
  await page.getByLabel("Data: ano", { exact: true }).press("Escape");
  assert.equal(await calendar.count(), 0);
  await page.getByLabel("Data: dia", { exact: true }).fill("31");
  await page.getByLabel("Data: mês", { exact: true }).fill("04");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "true");
  assert.equal(
    await page.locator('[data-fold="A"]').getAttribute("data-status"),
    "invalid",
  );
  await page.getByLabel("Data: dia", { exact: true }).fill("29");
  await page.getByLabel("Data: mês", { exact: true }).fill("02");
  await page.getByLabel("Data: ano", { exact: true }).fill("2024");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "false");
  await page.getByLabel("Data: ano", { exact: true }).fill("2025");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "true");
  await page.getByLabel("Data: dia", { exact: true }).fill("02");
  await page.getByLabel("Data: mês", { exact: true }).fill("10");
  await page.getByLabel("Data: ano", { exact: true }).fill("2026");
  await page.screenshot({
    path: path.join(output, "calendario-digitacao.png"),
  });
  await page.getByLabel("Data: ano", { exact: true }).press("Escape");
  const doc = String(Date.now()).slice(-11);
  console.log("QA: calendário e indicadores");
  async function catalog(kind, name, identifier, index = 0) {
    await page.getByRole("button", { name: "+ " + kind, exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Cadastro de " + kind });
    await modal.getByLabel("Nome", { exact: true }).fill(name);
    if (identifier)
      await modal
        .getByLabel(kind === "Cliente" ? "CNPJ" : "CPF", { exact: true })
        .fill(identifier);
    if (kind === "Equipamento") {
      await modal.getByLabel("Tipo", { exact: true }).fill("Guindaste");
      await modal.getByLabel("Modelo", { exact: true }).fill("LTM 1100");
    }
    await modal
      .getByRole("button", { name: "Salvar cadastro", exact: true })
      .click();
    await modal.waitFor({ state: "hidden" });
  }
  await catalog("Cliente", "Cliente QA " + tag, "123" + doc);
  // Entering identification with only the team missing opens the first professional.
  await page
    .getByRole("button", { name: "A. Identificação", exact: true })
    .click();
  await openSection("A. Identificação");
  await page.locator('select[aria-label="Profissional 1"]:focus').waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Equipe do atendimento", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await openSection(...teamPath, "Profissional 1");
  await catalog("Técnico", "Técnico QA " + tag, doc);
  const firstTech = await page
    .locator('select[aria-label="Profissional 1"]')
    .inputValue();
  await page
    .getByRole("button", { name: "+ Adicionar profissional", exact: true })
    .click();
  await openSection("B. Equipamento");
  await openSection("A. Identificação");
  await page.locator('select[aria-label="Profissional 2"]:focus').waitFor();
  await catalog(
    "Técnico",
    "Segundo técnico QA " + tag,
    String(Number(doc) + 1).padStart(11, "0"),
    1,
  );
  const secondTech = await page
    .locator('select[aria-label="Profissional 2"]')
    .inputValue();
  await page
    .getByRole("button", { name: "+ Adicionar profissional", exact: true })
    .click();
  await catalog(
    "Técnico",
    "Auxiliar QA " + tag,
    String(Number(doc) + 2).padStart(11, "0"),
    2,
  );
  await page
    .getByLabel("Função do profissional 3", { exact: true })
    .selectOption("auxiliary");
  assert.equal(
    await page
      .locator('select[aria-label="Profissional 3"]')
      .locator(`option[value="${firstTech}"]`)
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "+ Adicionar profissional", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remover profissional 4", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Função do profissional 2", { exact: true })
      .inputValue(),
    "technician",
  );
  await openSection(...teamPath, "Profissional 1");
  // A corrected CPF must clear its error before save, and a cancelled error cannot leak into the form.
  await page
    .getByRole("button", { name: "Editar técnico", exact: true })
    .first()
    .click();
  const technicianModal = page.getByRole("dialog", {
    name: "Cadastro de Técnico",
  });
  await technicianModal
    .getByLabel("CPF", { exact: true })
    .fill(String(Number(doc) + 1).padStart(11, "0"));
  await technicianModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await technicianModal.getByRole("alert").waitFor();
  await technicianModal
    .getByLabel("Nome", { exact: true })
    .fill("Técnico QA " + tag);
  assert.equal(await technicianModal.getByRole("alert").count(), 1);
  await technicianModal.getByLabel("CPF", { exact: true }).fill(doc);
  assert.equal(await technicianModal.getByRole("alert").count(), 0);
  await technicianModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await technicianModal.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("alert").count(), 0);
  await page
    .getByRole("button", { name: "Editar técnico", exact: true })
    .first()
    .click();
  await technicianModal
    .getByLabel("CPF", { exact: true })
    .fill(String(Number(doc) + 1).padStart(11, "0"));
  await technicianModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await technicianModal.getByRole("alert").waitFor();
  await technicianModal
    .getByRole("button", { name: "Cancelar", exact: true })
    .click();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(
    await page
      .getByRole("heading", { name: "B. Equipamento", exact: true })
      .count(),
    1,
  );
  console.log("QA: equipe e cadastros");
  await openSection("B. Equipamento");
  const eqSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "B. Equipamento", exact: true }),
  });
  assert.equal(
    await eqSection
      .getByLabel("Equipamento", { exact: true })
      .locator("option")
      .count(),
    1,
    "Novo cliente não pode listar equipamentos de outros clientes",
  );
  // Permanent data is grey and cannot receive mouse, keyboard or programmatic focus.
  for (const label of [
    "Tipo",
    "Marca",
    "Modelo",
    "Série/chassi",
    "Ano de fabricação",
    "Placa",
    "Frota",
  ]) {
    const input = eqSection.getByLabel(label, { exact: true });
    assert.equal(await input.isDisabled(), true);
    assert.equal(await input.getAttribute("tabindex"), "-1");
    assert.equal(
      await input.evaluate((el) => {
        el.focus();
        return document.activeElement === el;
      }),
      false,
    );
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    await page.mouse.click(box.x + 10, box.y + 10);
    assert.equal(
      await input.evaluate((el) => document.activeElement === el),
      false,
    );
    assert.equal(
      await input.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(43, 45, 50)",
    );
  }
  for (const label of [
    "KM na data",
    "Horímetro inferior na data",
    "Horímetro superior na data",
  ]) {
    assert.equal(
      await eqSection.getByLabel(label, { exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await eqSection
        .getByLabel(label, { exact: true })
        .getAttribute("readonly"),
      null,
    );
  }
  assert.equal(
    await eqSection
      .getByRole("button", { name: "Salvar novo equipamento", exact: true })
      .count(),
    0,
  );
  await eqSection
    .getByRole("button", { name: "+ Equipamento", exact: true })
    .click();
  const equipmentModal = page.getByRole("dialog", {
    name: "Cadastro de Equipamento",
  });
  await equipmentModal
    .getByRole("group", { name: "Tipo", exact: true })
    .getByRole("radio", { name: "Guindaste", exact: true })
    .check();
  await equipmentModal.getByLabel("Marca", { exact: true }).fill("Liebherr");
  await equipmentModal
    .getByLabel("Modelo", { exact: true })
    .fill("LTM QA " + tag);
  await equipmentModal
    .getByLabel("Série/chassi", { exact: true })
    .fill("SER-" + tag);
  await equipmentModal
    .getByLabel("Ano de fabricação", { exact: true })
    .fill("2020");
  await equipmentModal
    .getByRole("button", { name: "Não se aplica: Placa", exact: true })
    .click();
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  const equipmentId = await page
    .getByLabel("Equipamento", { exact: true })
    .inputValue();
  assert.ok(equipmentId);
  assert.equal(
    await eqSection.getByLabel("Marca", { exact: true }).inputValue(),
    "Liebherr",
  );
  assert.equal(
    await eqSection
      .getByRole("button", {
        name: "Editar leituras do atendimento",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(
    await eqSection
      .getByRole("button", { name: "Aplicar leituras", exact: true })
      .count(),
    0,
  );
  await eqSection.getByLabel("KM na data", { exact: true }).fill("-1");
  await eqSection.getByRole("alert").waitFor();
  await eqSection.getByLabel("KM na data", { exact: true }).fill("500");
  assert.equal(await eqSection.getByRole("alert").count(), 0);
  await eqSection
    .getByLabel("Horímetro inferior na data", { exact: true })
    .fill("25");
  await eqSection
    .getByRole("button", {
      name: "Não se aplica: Horímetro superior na data",
      exact: true,
    })
    .click();
  assert.equal(
    await eqSection.getByLabel("KM na data", { exact: true }).inputValue(),
    "500",
  );
  const storedEquipment = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/catalog/equipment")).json()).items.find(
        (i) => i.id === id,
      ),
    equipmentId,
  );
  for (const key of [
    "odometer",
    "hourmeter",
    "hourmeterLower",
    "hourmeterUpper",
  ])
    assert.equal(storedEquipment.data[key], undefined);
  assert.equal(storedEquipment.data.plate, "N/A");
  await eqSection
    .getByRole("button", { name: "Editar equipamento", exact: true })
    .click();
  await equipmentModal
    .getByLabel("Modelo", { exact: true })
    .fill("LTM revisado " + tag);
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  assert.equal(
    await eqSection.getByLabel("Modelo", { exact: true }).inputValue(),
    "LTM revisado " + tag,
  );
  assert.equal(
    await eqSection.getByLabel("KM na data", { exact: true }).inputValue(),
    "500",
  );
  const updatedEquipment = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/catalog/equipment")).json()).items.find(
        (i) => i.id === id,
      ),
    equipmentId,
  );
  assert.equal(updatedEquipment.data.model, "LTM revisado " + tag);
  await openSection("A. Identificação");
  await page
    .getByRole("button", { name: "Editar cliente", exact: true })
    .click();
  const clientModal = page.getByRole("dialog", { name: "Cadastro de Cliente" });
  await clientModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await clientModal.waitFor({ state: "hidden" });
  assert.equal(
    await eqSection.getByLabel("Equipamento", { exact: true }).inputValue(),
    equipmentId,
  );
  assert.equal(
    await eqSection.getByLabel("KM na data", { exact: true }).inputValue(),
    "500",
  );
  await openSection("B. Equipamento");
  await eqSection.screenshot({
    path: path.join(output, "equipamento-cadastro-leituras.png"),
  });
  console.log("QA: equipamento e leituras");
  await openSection("A. Identificação");
  await page.getByLabel("Local", { exact: true }).fill("Oficina BR LIFT");
  // Enter advances simple inputs; Tab opens the next nested branch.
  await page.getByLabel("Operador", { exact: true }).fill("Operador QA");
  await page.getByLabel("Operador", { exact: true }).press("Enter");
  assert.equal(
    await page
      .getByLabel("Solicitante", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Local", { exact: true }).focus();
  await page.getByLabel("Local", { exact: true }).press("Tab");
  await page.locator('select[aria-label="Profissional 1"]:focus').waitFor();
  assert.equal(
    await page
      .locator('select[aria-label="Profissional 1"]')
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Operador", { exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Equipe do atendimento", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await openSection(...teamPath, "Profissional 3");
  await page
    .getByRole("button", { name: "Remover profissional 3", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Profissional 3", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.keyboard.press("Tab");
  await page.locator('select[aria-label="Equipamento"]:focus').waitFor();
  assert.equal(
    await page
      .getByLabel("Equipamento", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await openSection("C. Motivos, serviços e pendências");
  await page.getByRole("button", { name: "+ Motivo", exact: true }).click();
  await page
    .getByLabel("Descrição do motivo", { exact: true })
    .fill("Manutenção preventiva");
  await page.getByLabel("Descrição do motivo", { exact: true }).press("End");
  await page.getByLabel("Descrição do motivo", { exact: true }).press("Enter");
  assert.ok(
    (
      await page.getByLabel("Descrição do motivo", { exact: true }).inputValue()
    ).includes("\n"),
  );
  await page
    .getByLabel("Descrição do motivo", { exact: true })
    .press("Control+Enter");
  await page
    .getByRole("button", { name: "+ Serviço deste motivo", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "+ Serviço deste motivo", exact: true })
    .click();
  await page
    .getByLabel("Serviço realizado", { exact: true })
    .fill("Verificação e ajuste do conjunto");
  const photo = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: "#cda332" },
  })
    .png()
    .toBuffer();
  await page.getByLabel("Adicionar fotos", { exact: true }).setInputFiles([
    { name: "evidencia.png", mimeType: "image/png", buffer: photo },
    { name: "evidencia-2.png", mimeType: "image/png", buffer: photo },
  ]);
  await page.getByAltText("evidencia.png", { exact: true }).waitFor();
  await page.getByAltText("evidencia-2.png", { exact: true }).waitFor();
  const servicePath = await page
    .locator('[data-fold][data-open="true"]')
    .evaluateAll((els) => els.map((el) => el.dataset.fold));
  await page
    .getByRole("heading", {
      name: "Atendimento técnico QA-AT-" + tag,
      exact: true,
    })
    .click();
  await page
    .getByLabel("Número identificador (único)", { exact: true })
    .click();
  assert.deepEqual(
    await page
      .locator('[data-fold][data-open="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.fold)),
    servicePath,
  );
  await page
    .locator('[data-fold="C"] > [data-fold-body] > .br-fold-hint')
    .click();
  assert.deepEqual(
    await page
      .locator('[data-fold][data-open="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.fold)),
    servicePath,
  );
  // Only an explicit header toggle closes everything.
  await page
    .getByRole("button", {
      name: "C. Motivos, serviços e pendências",
      exact: true,
    })
    .click();
  assert.equal(await page.locator('[data-fold][data-open="true"]').count(), 0);
  await page
    .getByRole("heading", {
      name: "Atendimento técnico QA-AT-" + tag,
      exact: true,
    })
    .click();
  assert.equal(await page.locator('[data-fold][data-open="true"]').count(), 0);
  await openSection(
    "C. Motivos, serviços e pendências",
    "Motivo 1",
    "Serviços deste motivo",
    "Serviço 1",
  );
  // Only the current repeated item stays expanded; collapsing preserves photos and text.
  await page
    .getByRole("button", { name: "+ Serviço deste motivo", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Serviço 1", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await openSection("A. Identificação");
  assert.equal(
    await page
      .getByRole("button", {
        name: "C. Motivos, serviços e pendências",
        exact: true,
      })
      .getAttribute("aria-expanded"),
    "false",
  );
  await openSection("C. Motivos, serviços e pendências");
  await page
    .getByRole("button", { name: "Serviço 2", exact: true, expanded: true })
    .waitFor();
  await page
    .locator("[data-fold-body]:visible")
    .getByLabel("Serviço realizado", { exact: true })
    .last()
    .fill("Segundo serviço");
  await page
    .getByRole("button", { name: "Remover serviço", exact: true })
    .click();
  await openSection("Serviço 1");
  assert.equal(
    await page.getByLabel("Serviço realizado", { exact: true }).inputValue(),
    "Verificação e ajuste do conjunto",
  );
  assert.equal(
    await page.getByAltText("evidencia-2.png", { exact: true }).isVisible(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "accordion-servicos-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "+ Motivo", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Motivo 1", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await page
    .getByRole("button", { name: "Remover motivo", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-fold="C"]').getAttribute("data-status"),
    "complete",
  );
  await openSection("D. Peças utilizadas / solicitadas");
  await page
    .getByRole("button", {
      name: "+ Adicionar peça ao atendimento",
      exact: true,
    })
    .click();
  const partSection = page.locator('[data-fold="D"]');
  assert.equal(
    await partSection
      .getByRole("button", { name: "Buscar código", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await partSection
      .getByRole("button", { name: "Salvar peça no catálogo", exact: true })
      .count(),
    0,
  );
  for (const label of ["Código da peça", "Descrição da peça", "Fornecedor"]) {
    const field = partSection.getByLabel(label, { exact: true });
    assert.equal(await field.isDisabled(), true);
    assert.equal(await field.getAttribute("tabindex"), "-1");
    assert.equal(
      await field.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(43, 45, 50)",
    );
  }
  await page.getByRole("button", { name: "+ Peça", exact: true }).click();
  const partModal = page.getByRole("dialog", {
    name: "Cadastro de Peça",
    exact: true,
  });
  await partModal
    .getByLabel("Descrição da peça", { exact: true })
    .fill("Peça de teste");
  await partModal.getByLabel("Código", { exact: true }).fill("PECA-" + tag);
  await partModal
    .getByLabel("Fornecedor", { exact: true })
    .fill("Fornecedor QA");
  await partModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await partModal.waitFor({ state: "hidden" });
  const partId = await page
    .getByLabel("Peça do catálogo", { exact: true })
    .inputValue();
  assert.ok(partId);
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "Peça de teste",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "Fornecedor QA",
  );
  await page.getByLabel("Quantidade", { exact: true }).fill("0");
  assert.equal(
    await page.locator('[data-fold="D"]').getAttribute("data-status"),
    "invalid",
  );
  await page.getByLabel("Quantidade", { exact: true }).fill("2");
  await page
    .getByLabel("Classificação", { exact: true })
    .selectOption("replaced");
  await page.getByRole("button", { name: "Editar peça", exact: true }).click();
  await partModal
    .getByLabel("Descrição da peça", { exact: true })
    .fill("Peça revisada");
  await partModal.getByLabel("Código", { exact: true }).fill("PECA-REV-" + tag);
  await partModal
    .getByLabel("Fornecedor", { exact: true })
    .fill("Fornecedor revisado");
  await partModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await partModal.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).inputValue(),
    "2",
  );
  assert.equal(
    await page.getByLabel("Classificação", { exact: true }).inputValue(),
    "replaced",
  );
  assert.equal(
    await page.getByLabel("Código da peça", { exact: true }).inputValue(),
    ("PECA-REV-" + tag).toUpperCase(),
  );
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "Peça revisada",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "Fornecedor revisado",
  );
  const storedPart = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/catalog/parts")).json()).items.find(
        (i) => i.id === id,
      ),
    partId,
  );
  assert.ok(
    storedPart.data.codeHistory.includes(("PECA-" + tag).toUpperCase()),
  );
  assert.equal(storedPart.data.quantity, undefined);
  assert.equal(storedPart.data.kind, undefined);
  await partSection.screenshot({
    path: path.join(output, "pecas-cadastro-modal.png"),
  });
  assert.equal(
    await page.locator('[data-fold="D"]').getAttribute("data-status"),
    "complete",
  );
  await page
    .getByRole("button", {
      name: "+ Adicionar peça ao atendimento",
      exact: true,
    })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Peça 1", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  const secondPart = page
    .getByLabel("Peça do catálogo", { exact: true })
    .last();
  await secondPart.selectOption(partId);
  assert.equal(
    await page
      .getByLabel("Descrição da peça", { exact: true })
      .last()
      .inputValue(),
    "Peça revisada",
  );
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).last().inputValue(),
    "1",
  );
  assert.equal(
    await page.getByLabel("Classificação", { exact: true }).last().inputValue(),
    "requested",
  );
  await page.getByRole("button", { name: "Remover peça", exact: true }).click();
  await openSection("Peça 1");
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).inputValue(),
    "2",
  );
  await openSection("E. Cronograma de atendimento");
  await page
    .getByRole("button", { name: "+ Dia de atendimento", exact: true })
    .click();
  // All date fields (including the schedule) use the shared component.
  const scheduleDateLabel = await page
    .locator(".br-date")
    .last()
    .locator(".br-field-label")
    .innerText();
  await page
    .getByRole("button", {
      name: "Abrir calendário: " + scheduleDateLabel,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", {
      name: "Calendário: " + scheduleDateLabel,
      exact: true,
    })
    .getByRole("button", { name: "Hoje", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Horímetro inferior do dia", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Horímetro superior do dia", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Período da pausa", { exact: true }).count(),
    0,
  );
  await page
    .getByLabel("Observações do dia (opcional)", { exact: true })
    .fill("Trânsito intenso na BR-381; atraso de 2h no retorno.");
  await openSection("Técnico QA " + tag);
  await page.getByLabel("KM inicial", { exact: true }).fill("100");
  await page.getByLabel("KM final", { exact: true }).fill("125");
  await openSection("Trabalho");
  await page.getByRole("button", { name: "+ Trabalho", exact: true }).click();
  const work = page
    .getByRole("heading", { name: "Trabalho 1", exact: true })
    .locator("..");
  // A full-surface time picker preserves segmented typing and supports every minute.
  const start = work.getByRole("group", { name: "Início", exact: true });
  await start.click({ position: { x: 120, y: 20 } });
  const timePicker = work.getByRole("dialog", {
    name: "Selecionar horário: Início",
    exact: true,
  });
  await timePicker.waitFor();
  await work.getByLabel("Início: hora", { exact: true }).fill("08");
  await work.getByLabel("Início: hora", { exact: true }).click();
  assert.equal(
    await work
      .getByLabel("Início: hora", { exact: true })
      .evaluate((el) => el.selectionEnd - el.selectionStart),
    2,
  );
  await work
    .getByLabel("Início: hora", { exact: true })
    .pressSequentially("09");
  await work.getByLabel("Início: minuto", { exact: true }).evaluate((el) => {
    if (el !== document.activeElement) throw Error("Não avançou para minuto");
  });
  await work.getByLabel("Início: minuto", { exact: true }).fill("07");
  await timePicker
    .getByRole("button", { name: "Hora 08", exact: true })
    .click();
  await timePicker
    .getByRole("button", { name: "Minuto 00", exact: true })
    .click();
  assert.equal(
    await work.getByLabel("Início: hora", { exact: true }).inputValue(),
    "08",
  );
  assert.equal(
    await work.getByLabel("Início: minuto", { exact: true }).inputValue(),
    "00",
  );
  await work.getByLabel("Início: minuto", { exact: true }).press("Tab");
  await work.locator('input[aria-label="Fim: hora"]:focus').waitFor();
  await work.getByLabel("Fim: hora", { exact: true }).fill("24");
  await work.getByLabel("Fim: minuto", { exact: true }).fill("00");
  assert.equal(
    await page.locator('[data-fold="E"]').getAttribute("data-status"),
    "invalid",
  );
  await work.getByLabel("Fim: hora", { exact: true }).fill("17");
  assert.equal(
    await work
      .getByRole("group", { name: "Fim", exact: true })
      .getAttribute("aria-invalid"),
    "false",
  );
  await work.getByLabel("Fim: minuto", { exact: true }).press("Escape");
  assert.equal(
    await work
      .getByRole("dialog", { name: "Selecionar horário: Fim", exact: true })
      .count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await work
    .getByRole("button", { name: "Abrir horários: Início", exact: true })
    .click();
  const timeBox = await timePicker.boundingBox();
  assert.ok(timeBox.x >= 0 && timeBox.x + timeBox.width <= 390);
  await page.screenshot({
    path: path.join(output, "horario-segmentado-mobile.png"),
  });
  await work.getByLabel("Início: hora", { exact: true }).press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await work
    .getByLabel("Pausa em minutos (opcional)", { exact: true })
    .fill("60");
  async function addPeriod(group, short, index, start, end, pause = "") {
    await openSection(group);
    await page.getByRole("button", { name: "+ " + short, exact: true }).click();
    const panel = page
      .getByRole("heading", { name: short + " " + index, exact: true })
      .locator("..");
    for (const [label, value] of [
      ["Início", start],
      ["Fim", end],
    ]) {
      await panel
        .getByLabel(label + ": hora", { exact: true })
        .fill(value.slice(0, 2));
      await panel
        .getByLabel(label + ": minuto", { exact: true })
        .fill(value.slice(3));
      await panel
        .getByLabel(label + ": minuto", { exact: true })
        .press("Escape");
    }
    await panel
      .getByLabel("Pausa em minutos (opcional)", { exact: true })
      .fill(pause);
  }
  await addPeriod("Trabalho", "Trabalho", 2, "18:00", "19:00", "15");
  assert.equal(
    await page
      .getByRole("button", { name: "Trabalho 1", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await addPeriod("Deslocamento de ida", "Ida", 1, "06:00", "07:00", "10");
  await addPeriod("Deslocamento de ida", "Ida", 2, "07:00", "07:30");
  await addPeriod("Deslocamento de volta", "Volta", 1, "19:00", "20:00", "5");
  await addPeriod("Deslocamento de volta", "Volta", 2, "20:15", "20:45");
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "525 min de trabalho · 165 min de deslocamento · 25 km",
    ),
  );
  await page.screenshot({
    path: path.join(output, "cronograma-multiplos-periodos.png"),
    fullPage: true,
  });
  // Per-day attendance, linked schedules, separate schedules and carpool KM.
  const attendance = page.getByRole("group", {
    name: "Quem trabalhou neste dia?",
    exact: true,
  });
  assert.equal(await attendance.getByRole("checkbox").count(), 3);
  assert.equal(
    await attendance.getByRole("checkbox", { checked: true }).count(),
    1,
  );
  await attendance
    .getByRole("checkbox", {
      name: "Segundo técnico QA " + tag + " (Técnico)",
      exact: true,
    })
    .check();
  const secondPerson = page.locator(`[data-fold="person-${secondTech}"]`);
  await secondPerson
    .getByRole("checkbox", { name: "Mesmo horário", exact: true })
    .check();
  await secondPerson
    .getByRole("checkbox", { name: "Mesmo carro", exact: true })
    .check();
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "1050 min de trabalho · 330 min de deslocamento · 25 km",
    ),
  );
  await page.screenshot({
    path: path.join(output, "cronograma-equipe-compartilhado.png"),
    fullPage: true,
  });
  await secondPerson
    .getByRole("checkbox", { name: "Mesmo horário", exact: true })
    .uncheck();
  await secondPerson
    .getByRole("button", { name: "Trabalho", exact: true })
    .click();
  await secondPerson
    .getByRole("button", { name: "Trabalho 1", exact: true })
    .click();
  const secondWork = secondPerson
    .getByRole("heading", { name: "Trabalho 1", exact: true })
    .locator("..");
  await secondWork.getByLabel("Fim: hora", { exact: true }).fill("14");
  await secondWork.getByLabel("Fim: minuto", { exact: true }).press("Escape");
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "870 min de trabalho · 330 min de deslocamento · 25 km",
    ),
  );
  await attendance
    .getByRole("checkbox", {
      name: "Técnico QA " + tag + " (Técnico)",
      exact: true,
    })
    .uncheck();
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "345 min de trabalho · 165 min de deslocamento · 25 km",
    ),
  );
  assert.equal(
    await attendance.getByRole("checkbox", { checked: true }).count(),
    1,
  );
  await openSection("Segundo técnico QA " + tag);
  assert.equal(
    await secondPerson
      .getByRole("checkbox", { name: "Mesmo carro", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: path.join(output, "cronograma-apenas-segundo-profissional.png"),
    fullPage: true,
  });
  // Restore the baseline participant, preserving the independent data of the absent one.
  await attendance
    .getByRole("checkbox", {
      name: "Técnico QA " + tag + " (Técnico)",
      exact: true,
    })
    .check();
  await attendance
    .getByRole("checkbox", {
      name: "Segundo técnico QA " + tag + " (Técnico)",
      exact: true,
    })
    .uncheck();
  await openSection("Técnico QA " + tag);
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "525 min de trabalho · 165 min de deslocamento · 25 km",
    ),
  );
  await page
    .getByRole("button", { name: "+ Dia de atendimento", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Dia 1", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await page.getByRole("button", { name: "Remover dia", exact: true }).click();
  await openSection("Dia 1");
  await openSection("Técnico QA " + tag);
  assert.equal(
    await page.getByLabel("KM final", { exact: true }).inputValue(),
    "125",
  );
  console.log("QA: motivos, serviços, peças e cronograma");
  await openSection("F. Status final");
  // Final questions stack vertically at every width; each Sim/Não pair shares one row.
  const finalQuestions = page.locator(".br-final-questions");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await finalQuestions.evaluate((root) =>
      Array.from(root.querySelectorAll("fieldset")).map((group) => {
        const rect = group.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          options: Array.from(group.querySelectorAll("label")).map((label) => {
            const r = label.getBoundingClientRect();
            return { top: r.top, left: r.left, right: r.right, width: r.width };
          }),
        };
      }),
    );
    assert.equal(layout.length, 3);
    for (const [index, row] of layout.entries()) {
      if (index)
        assert.ok(
          row.top >= layout[index - 1].bottom + 12,
          "Perguntas devem ficar uma abaixo da outra",
        );
      assert.equal(row.options.length, 2);
      const [yes, no] = row.options;
      assert.ok(
        Math.abs(yes.top - no.top) < 1,
        "Sim e Não devem ficar lado a lado",
      );
      assert.ok(
        Math.abs(yes.width - no.width) < 1,
        "Opções devem ter a mesma largura",
      );
      assert.ok(yes.right < no.left);
      assert.ok(row.left >= 0 && row.right <= width, "Sem overflow horizontal");
    }
    await finalQuestions.screenshot({
      path: path.join(output, `status-final-${width}.png`),
    });
  }
  const concluded = page.getByRole("group", {
    name: "Atendimento concluído",
    exact: true,
  });
  await concluded.getByRole("radio", { name: "Não", exact: true }).check();
  assert.equal(
    await concluded
      .getByRole("radio", { name: "Não", exact: true })
      .isChecked(),
    true,
  );
  await concluded.getByRole("radio", { name: "Sim", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await concluded
      .getByRole("radio", { name: "Sim", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await concluded
      .getByRole("radio", { name: "Não", exact: true })
      .isChecked(),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const label of [
    "Atendimento concluído",
    "Equipamento liberado",
    "Fotos enviadas",
  ])
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("radio", { name: "Sim", exact: true })
      .check();
  async function sign(label) {
    if (label === "Assinatura da inspeção") {
      const inspectionCanvas = page.getByLabel(label, { exact: true });
      await inspectionCanvas.scrollIntoViewIfNeeded();
      const inspectionBox = await inspectionCanvas.boundingBox();
      await page.mouse.move(inspectionBox.x + 30, inspectionBox.y + 50);
      await page.mouse.down();
      await page.mouse.move(inspectionBox.x + 100, inspectionBox.y + 80, {
        steps: 6,
      });
      await page.mouse.move(inspectionBox.x + 200, inspectionBox.y + 30, {
        steps: 6,
      });
      await page.mouse.up();
      await inspectionCanvas
        .locator("..")
        .getByRole("button", { name: "Salvar assinatura", exact: true })
        .click();
      await page.getByAltText(label + " salva", { exact: true }).waitFor();
      return;
    }
    const card = page
      .locator(".br-signature")
      .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "Assinar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await dialog.waitFor();
    if (label === "Assinatura do técnico") {
      const portrait = await dialog.boundingBox();
      assert.ok(portrait.width >= 1400, "Editor ocupa a tela inteira");
      await dialog
        .getByRole("button", { name: "Cancelar", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await card.getByAltText(label + " salva", { exact: true }).count(),
        0,
        "Cancelar não salva",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await card.getByRole("button", { name: "Assinar", exact: true }).click();
      await dialog.waitFor();
      const mobilePortrait = await dialog.boundingBox();
      assert.ok(
        mobilePortrait.width >= 380 && mobilePortrait.height >= 830,
        "Editor ocupa a tela no celular",
      );
      await page.setViewportSize({ width: 844, height: 390 });
      const landscape = await dialog.boundingBox();
      assert.ok(
        landscape.width >= 840 && landscape.height >= 380,
        "Editor acompanha a orientação paisagem",
      );
    }
    const c = dialog.getByLabel("Área para " + label.toLowerCase(), {
      exact: true,
    });
    await c.scrollIntoViewIfNeeded();
    const box = await c.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80, { steps: 6 });
    await page.mouse.move(box.x + 200, box.y + 30, { steps: 6 });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await card.getByAltText(label + " salva", { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await sign("Assinatura do técnico");
  await sign("Assinatura do cliente");
  for (const id of ["A", "B", "C", "D", "E", "F"])
    assert.equal(
      await page
        .locator(`[data-main-fold="true"][data-fold="${id}"]`)
        .getAttribute("data-status"),
      "complete",
    );
  await page.screenshot({
    path: path.join(output, "accordion-finalizacao.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Finalizar atendimento", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "finalizado" }).waitFor();
  const reportDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Baixar PDF salvo", exact: true })
    .click();
  await (await reportDownload).saveAs(path.join(output, "atendimento.pdf"));
  await page
    .getByRole("button", { name: "← Voltar à gestão", exact: true })
    .click();
  await page
    .getByLabel("Buscar número, cliente ou técnico", { exact: true })
    .fill("QA-AT-" + tag);
  await page
    .getByRole("cell", { name: "QA-AT-" + tag, exact: false })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "gestao-atendimentos.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Resumo", exact: true }).click();
  const reportSummary = page.getByRole("dialog", {
    name: "Resumo do registro",
  });
  for (const title of [
    "A. Identificação",
    "B. Equipamento",
    "C. Motivos, serviços e pendências",
    "D. Peças utilizadas / solicitadas",
    "E. Cronograma",
    "F. Finalização",
  ])
    assert.equal(
      await reportSummary
        .getByRole("heading", { name: title, exact: true })
        .count(),
      1,
    );
  assert.ok((await reportSummary.innerText()).includes("LTM revisado " + tag));
  for (const label of [
    "Deslocamento de ida 2",
    "Trabalho 2",
    "Deslocamento de volta 2",
    "525 min de trabalho · 165 min de deslocamento · 25 km",
  ])
    assert.ok((await reportSummary.innerText()).includes(label));
  assert.ok(
    (await reportSummary.innerText()).includes(
      "Trânsito intenso na BR-381; atraso de 2h no retorno.",
    ),
  );
  assert.equal(
    await reportSummary
      .getByAltText("evidencia-2.png", { exact: true })
      .count(),
    1,
  );
  await reportSummary.screenshot({
    path: path.join(output, "resumo-atendimento.png"),
  });
  await page
    .getByRole("dialog", { name: "Resumo do registro" })
    .getByRole("button", { name: "Editar", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Peça do catálogo", { exact: true }).inputValue(),
    partId,
  );
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "Peça revisada",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "Fornecedor revisado",
  );
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).inputValue(),
    "2",
  );
  assert.equal(
    await page.getByLabel("Classificação", { exact: true }).inputValue(),
    "replaced",
  );
  assert.equal(
    await page.locator('select[aria-label="Profissional 2"]').inputValue(),
    secondTech,
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 3", { exact: true })
      .inputValue(),
    "auxiliary",
  );
  await openSection(...teamPath, "Profissional 1");
  await page.screenshot({
    path: path.join(output, "equipe-atendimento.png"),
    fullPage: true,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "equipe-cabecalho.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await openSection("A. Identificação");
  await page
    .getByRole("button", { name: "Abrir calendário: Data", exact: true })
    .click();
  const calendarBox = await page
    .getByRole("dialog", { name: "Calendário: Data", exact: true })
    .boundingBox();
  assert.ok(calendarBox.x >= 0 && calendarBox.x + calendarBox.width <= 390);
  await page.screenshot({
    path: path.join(output, "calendario-responsivo.png"),
  });
  await page.getByLabel("Data: dia", { exact: true }).press("Escape");
  await page.screenshot({
    path: path.join(output, "equipe-responsiva.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSection(...teamPath, "Profissional 2");
  await page
    .getByLabel("Função do profissional 2", { exact: true })
    .selectOption("auxiliary");
  await openSection(...teamPath, "Profissional 1");
  await page
    .getByRole("button", { name: "Remover profissional 1", exact: true })
    .click();
  assert.equal(
    await page.locator('select[aria-label="Profissional 1"]').inputValue(),
    secondTech,
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .inputValue(),
    "technician",
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Local", { exact: true }).inputValue(),
    "Oficina BR LIFT",
  );
  assert.equal(
    await page.getByLabel("KM na data", { exact: true }).inputValue(),
    "500",
  );
  assert.equal(
    await page
      .getByLabel("Horímetro inferior na data", { exact: true })
      .inputValue(),
    "25",
  );
  assert.equal(
    await page
      .getByLabel("Horímetro superior na data", { exact: true })
      .inputValue(),
    "N/A",
  );
  assert.equal(
    await page.getByLabel("Horímetro superior do dia", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Local", { exact: true }).fill("Oficina revisada");
  // Removing the only present team member must not silently assign his hours to someone else.
  await openSection("E. Cronograma de atendimento", "Dia 1");
  await page
    .getByRole("group", { name: "Quem trabalhou neste dia?", exact: true })
    .getByRole("checkbox", {
      name: "Segundo técnico QA " + tag + " (Técnico)",
      exact: true,
    })
    .check();
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "345 min de trabalho",
    ),
  );
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Registro salvo" })
    .waitFor();
  await page.getByRole("button", { name: "Inspeções", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Nova inspeção", exact: true })
    .click();
  await page
    .getByLabel("Número identificador (único)", { exact: true })
    .fill("QA-IN-" + tag);
  await page
    .getByLabel("Cliente", { exact: true })
    .selectOption({ label: "Cliente QA " + tag + " — 123" + doc });
  await page
    .getByLabel("Técnico", { exact: true })
    .selectOption({ label: "Técnico QA " + tag + " — " + doc });
  await page
    .getByLabel("Equipamento", { exact: true })
    .selectOption(equipmentId);
  for (const label of ["DATA DE VISTORIA", "PRÓXIMA VISTORIA"]) {
    await page
      .getByRole("button", { name: "Abrir calendário: " + label, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Calendário: " + label, exact: true })
      .getByRole("button", { name: "Hoje", exact: true })
      .click();
  }
  for (const summary of await page.locator("details > summary").all())
    await summary.click();
  for (const button of await page
    .getByRole("button", { name: "A", exact: true })
    .all())
    await button.click();
  await page
    .getByLabel("Observações do item", { exact: true })
    .first()
    .fill("Conferido presencialmente");
  await page
    .getByLabel("Adicionar fotos", { exact: true })
    .nth(2)
    .setInputFiles([
      { name: "inspecao-1.png", mimeType: "image/png", buffer: photo },
      { name: "inspecao-2.png", mimeType: "image/png", buffer: photo },
    ]);
  await page.getByAltText("inspecao-2.png", { exact: true }).waitFor();
  const extra = page.locator(".br-item").filter({
    has: page.getByRole("heading", {
      name: "126 — Cabo de aço do guincho principal",
      exact: true,
    }),
  });
  await extra
    .getByLabel("Adicionar fotos", { exact: true })
    .nth(1)
    .setInputFiles({
      name: "cabo-complementar.png",
      mimeType: "image/png",
      buffer: photo,
    });
  await extra.getByAltText("cabo-complementar.png", { exact: true }).waitFor();
  await extra
    .getByLabel("Observações do item", { exact: true })
    .fill("Diâmetro nominal medido: 20 mm; laudo informado pelo examinador.");
  await sign("Assinatura da inspeção");
  await page
    .getByRole("button", { name: "Finalizar inspeção", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "finalizado" }).waitFor();
  const inspectionDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Baixar PDF salvo", exact: true })
    .click();
  await (await inspectionDownload).saveAs(path.join(output, "inspecao.pdf"));
  await page
    .getByRole("button", { name: "← Voltar à gestão", exact: true })
    .click();
  await page
    .getByLabel("Buscar número, cliente ou técnico", { exact: true })
    .fill("QA-IN-" + tag);
  await page
    .getByRole("cell", { name: "QA-IN-" + tag, exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Resumo", exact: true }).click();
  const inspectionSummary = page.getByRole("dialog", {
    name: "Resumo do registro",
  });
  assert.ok(
    (await inspectionSummary.innerText()).includes("Dados da inspeção"),
  );
  await inspectionSummary
    .locator("summary")
    .filter({ hasText: "Acessórios de içamento" })
    .click();
  await inspectionSummary
    .getByAltText("cabo-complementar.png", { exact: true })
    .waitFor();
  await inspectionSummary
    .getByRole("button", { name: "Fechar", exact: true })
    .click();
  await page.screenshot({
    path: path.join(output, "gestao-inspecoes.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "gestao-responsiva.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  for (const file of ["atendimento.pdf", "inspecao.pdf"])
    assert.equal(
      (await fs.readFile(path.join(output, file))).subarray(0, 4).toString(),
      "%PDF",
    );
  console.log(
    "E2E PASS: accordions exclusivos, indicadores, Tab/Enter, conservação do preenchimento, calendário e digitação segmentada, equipamento por cliente, cadastro/edição inline, leituras separadas, N/A, equipe mista, persistência, layout responsivo, inspeções e PDFs.",
  );
} catch (error) {
  console.error(error);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({
        path: path.join(output, "falha.png"),
        fullPage: true,
      });
      console.error((await page.locator("body").innerText()).slice(-4000));
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  await new Promise((r) => server.close(r));
  await pool.end();
}
