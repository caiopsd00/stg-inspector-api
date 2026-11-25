// Isolated end-to-end QA: never creates users or sample data in production.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import JSZip from "jszip";
import { chromium } from "playwright";
if (!process.env.DATABASE_URL?.endsWith("/brlift_test"))
  throw Error("Defina DATABASE_URL para brlift_test.");
process.env.NODE_ENV = "test";
const webRoot = path.resolve(process.env.WEB_REPO || "../stg-system-web");
const webPort = Number(process.env.E2E_WEB_PORT || 5176);
process.env.WEB_ORIGIN = "http://127.0.0.1:" + webPort;
process.env.STORAGE_DIR = process.env.STORAGE_DIR || "storage-test";
const { pool } = await import("../dist/server/db.js");
const { migrate } = await import("../dist/server/migrate.js");
const { createUserAndTechnician } = await import("../dist/server/users.js");
const { saveCatalogItem } =
  await import("../dist/server/application/catalog-service.js");
const { createApp } = await import("../dist/server/app.js");
const { createTemplateSections } =
  await import("../dist/contracts/inspection-template.js");
await migrate();
const tag = crypto.randomUUID().slice(0, 8).toUpperCase(),
  doc = String(Date.now()).slice(-11),
  email = "qa-" + tag.toLowerCase() + "@example.test",
  password = crypto.randomBytes(18).toString("hex");
const adminAccount = await createUserAndTechnician({
  name: "QA BR LIFT",
  email,
  password,
  role: "admin",
});
const basicTechnician = await saveCatalogItem(
  "technicians",
  crypto.randomUUID(),
  {
    id: crypto.randomUUID(),
    name: "Cadastro básico QA " + tag,
    identifier: String(Number(doc) + 4).padStart(11, "0"),
    data: {},
    baseVersion: 0,
  },
  adminAccount.user,
);
// Professionals are registered through Users, never from inline selectors.
for (const [index, name] of [
  "Técnico QA ",
  "Segundo técnico QA ",
  "Auxiliar QA ",
].entries())
  await createUserAndTechnician({
    name: (name + tag).toUpperCase(),
    email: `team-${index}-${tag.toLowerCase()}@example.test`,
    password,
    role: "technician",
    cpf: String(Number(doc) + index).padStart(11, "0"),
  });
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
await fs.rm(path.join(output, "falha.png"), { force: true });
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
  async function pickCatalog(locator, value) {
    if (await locator.evaluate((el) => el.tagName === "SELECT"))
      return locator.selectOption(value);
    await locator.fill("");
    await locator.click();
    const controls = await locator.getAttribute("aria-controls");
    await page
      .locator(
        '[id="' + controls + '"] [role="option"][data-value="' + value + '"]',
      )
      .click();
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function openSection(...titles) {
    for (const title of titles) {
      const button = page.getByRole("button", { name: title, exact: true });
      if ((await button.getAttribute("aria-expanded")) !== "true")
        await button.click();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    }
    assert.ok(
      (await page
        .locator('[data-main-fold="true"][data-open="true"]')
        .count()) <= 1,
    );
  }
  const teamPath = ["A. Identificação", "Equipe do atendimento"];
  async function assertSameDayEnd(panel, originalStart, originalEnd) {
    async function fillTime(label, value) {
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
    await fillTime("Início", "03:30");
    await fillTime("Fim", "01:00");
    const error = panel.getByRole("alert").filter({ hasText: "até 23:59" });
    await error.waitFor();
    assert.equal(
      await panel
        .getByLabel("Fim: hora", { exact: true })
        .getAttribute("aria-invalid"),
      "true",
    );
    await fillTime("Fim", "23:59");
    assert.equal(await error.count(), 0);
    assert.equal(
      await panel
        .getByLabel("Fim: hora", { exact: true })
        .getAttribute("aria-invalid"),
      "false",
    );
    await fillTime("Início", originalStart);
    await fillTime("Fim", originalEnd);
  }
  await page.goto(process.env.WEB_ORIGIN);
  await page.getByRole("heading", { name: "Acesse sua operação" }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page
        .getByRole("img", { name: "BR LIFT", exact: true })
        .evaluate(async (img) => {
          await img.decode();
          return img.complete && img.naturalWidth > 0;
        }),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(output, `marca-login-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Relatório Técnico", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Cadastros", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Adicionar usuário", exact: true })
    .click();
  const userModal = page.getByRole("dialog", {
    name: "Adicionar usuário",
    exact: true,
  });
  await userModal
    .getByLabel("Perfil de acesso", { exact: true })
    .selectOption("admin");
  assert.equal(await userModal.getByLabel("CPF", { exact: true }).count(), 0);
  await userModal
    .getByLabel("Perfil de acesso", { exact: true })
    .selectOption({ label: "Técnico + ADM" });
  const cpf = userModal.getByLabel("CPF", { exact: true });
  const cpfDigits = String(crypto.randomInt(10_000_000_000, 99_999_999_999));
  await cpf.fill(cpfDigits);
  assert.match(await cpf.inputValue(), /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
  assert.equal(await cpf.getAttribute("inputmode"), "numeric");
  await userModal
    .getByLabel("Nome completo", { exact: true })
    .fill("Técnico adm QA " + tag);
  await userModal
    .getByLabel("E-mail de acesso", { exact: true })
    .fill(`tech-admin-${tag.toLowerCase()}@example.test`);
  await userModal
    .getByLabel("Senha inicial", { exact: true })
    .fill(crypto.randomBytes(18).toString("hex"));
  await userModal
    .getByRole("button", { name: "Criar usuário", exact: true })
    .click();
  await userModal.waitFor({ state: "hidden" });
  assert.ok(
    (
      await page.evaluate(
        async () =>
          (await (await fetch("/api/catalog/technicians")).json()).items,
      )
    ).some((item) => item.identifier === cpfDigits),
  );
  const otherUserCard = page
    .locator(".br-user-card")
    .filter({ hasText: `tech-admin-${tag.toLowerCase()}@example.test` });
  const ownUserCard = page.locator(".br-user-card").filter({ hasText: email });
  const identityBefore = await page.evaluate(
    async () => (await (await fetch("/api/auth/me")).json()).user,
  );
  await otherUserCard
    .getByRole("button", { name: "Editar", exact: true })
    .click();
  const editUser = page.getByRole("dialog", {
    name: "Editar usuário",
    exact: true,
  });
  await editUser
    .getByLabel("Perfil de acesso", { exact: true })
    .selectOption("technician");
  await editUser
    .getByRole("button", { name: "Salvar alterações", exact: true })
    .click();
  await editUser.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: "Cadastros", exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Editar perfil", exact: true })
      .count(),
    0,
  );
  await ownUserCard.locator(".br-user-you").waitFor();
  assert.equal(await otherUserCard.locator(".br-user-you").count(), 0);
  assert.equal(
    await otherUserCard.getByText("Técnico", { exact: true }).count(),
    1,
  );
  assert.equal(
    await ownUserCard.getByText("Administrador", { exact: true }).count(),
    1,
  );
  const identityAfter = await page.evaluate(
    async () => (await (await fetch("/api/auth/me")).json()).user,
  );
  assert.deepEqual(identityAfter, identityBefore);
  await ownUserCard
    .getByRole("button", { name: "Editar", exact: true })
    .click();
  await editUser
    .getByLabel("Nome completo", { exact: true })
    .fill("Admin QA revisado " + tag);
  await editUser
    .getByRole("button", { name: "Salvar alterações", exact: true })
    .click();
  await editUser.waitFor({ state: "hidden" });
  await ownUserCard
    .getByText("ADMIN QA REVISADO " + tag, { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Cadastros", exact: true }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Editar perfil", exact: true })
      .count(),
    0,
  );
  console.log(
    "QA: editar outro usuário preserva a identidade e o acesso administrativo sem refresh",
  );
  await page
    .getByRole("button", { name: "Relatório Técnico", exact: true })
    .click();
  await page
    .getByRole("button", { name: "+ Novo atendimento", exact: true })
    .click();
  await page
    .getByLabel("O.S. OMIE", { exact: true })
    .fill("qa-at-" + tag.toLowerCase());
  await page.getByLabel("O.S. OMIE", { exact: true }).press("Tab");
  assert.equal(
    await page
      .getByLabel("O.S. OMIE", { exact: true })
      .getAttribute("inputmode"),
    "numeric",
  );
  await page.locator('input[aria-label="Cliente"]:focus').waitFor();
  assert.equal(
    await page.getByLabel("O.S. OMIE", { exact: true }).inputValue(),
    "QA-AT-" + tag,
  );
  await openSection("A. Identificação");
  assert.equal(
    await page
      .getByLabel("O.S. OMIE", { exact: true })
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
    false,
  );
  await openSection(...teamPath, "Profissional 1");
  await page
    .getByLabel("Função do profissional 1", { exact: true })
    .selectOption("auxiliary");
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .inputValue(),
    "auxiliary",
  );
  await page
    .getByLabel("Função do profissional 1", { exact: true })
    .selectOption("technician");
  const typeGroup = page.getByRole("group", {
    name: "Tipo de atendimento",
    exact: true,
  });
  assert.equal(await page.getByLabel("Data: dia", { exact: true }).count(), 0);
  for (const type of ["Interno (Galpão BR LIFT)", "Remoto"]) {
    await typeGroup.getByRole("radio", { name: type, exact: true }).check();
    assert.equal(await page.getByLabel("Local", { exact: true }).count(), 0);
  }
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
  // The whole date surface opens the calendar without stealing segment focus.
  const dateGroup = page.getByRole("group", {
    name: "Data do dia",
    exact: true,
  });
  for (const segment of ["dia", "mês", "ano"])
    assert.equal(
      await page
        .getByLabel("Data do dia: " + segment, { exact: true })
        .getAttribute("inputmode"),
      "numeric",
    );
  await dateGroup.click({ position: { x: 220, y: 20 } });
  const calendar = page.getByRole("dialog", {
    name: "Calendário: Data do dia",
    exact: true,
  });
  await calendar.waitFor();
  await page.getByLabel("Data do dia: dia", { exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Data do dia: dia", { exact: true })
      .evaluate((el) => el.selectionEnd - el.selectionStart),
    2,
  );
  await page
    .getByLabel("Data do dia: dia", { exact: true })
    .pressSequentially("02");
  assert.equal(
    await page
      .getByLabel("Data do dia: mês", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByLabel("Data do dia: mês", { exact: true })
    .pressSequentially("10");
  assert.equal(
    await page
      .getByLabel("Data do dia: ano", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByLabel("Data do dia: ano", { exact: true })
    .pressSequentially("2026");
  await calendar
    .getByRole("button", { name: "03/10/2026", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Data do dia: dia", { exact: true }).inputValue(),
    "03",
  );
  await page
    .getByRole("button", { name: "Abrir calendário: Data do dia", exact: true })
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
  await page.getByLabel("Data do dia: ano", { exact: true }).press("Escape");
  assert.equal(await calendar.count(), 0);
  await page.getByLabel("Data do dia: dia", { exact: true }).fill("31");
  await page.getByLabel("Data do dia: mês", { exact: true }).fill("04");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "true");
  await page.getByLabel("Data do dia: dia", { exact: true }).fill("29");
  await page.getByLabel("Data do dia: mês", { exact: true }).fill("02");
  await page.getByLabel("Data do dia: ano", { exact: true }).fill("2024");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "false");
  await page.getByLabel("Data do dia: ano", { exact: true }).fill("2025");
  assert.equal(await dateGroup.getAttribute("aria-invalid"), "true");
  await page.getByLabel("Data do dia: dia", { exact: true }).fill("02");
  await page.getByLabel("Data do dia: mês", { exact: true }).fill("10");
  await page.getByLabel("Data do dia: ano", { exact: true }).fill("2026");
  await page.screenshot({
    path: path.join(output, "calendario-digitacao.png"),
  });
  await page.getByLabel("Data do dia: ano", { exact: true }).press("Escape");
  await page.getByRole("button", { name: "Remover dia", exact: true }).click();
  await openSection("A. Identificação");
  await typeGroup.getByRole("radio", { name: "Externo", exact: true }).check();
  console.log("QA: calendário e indicadores");
  async function catalog(kind, name, identifier, index = 0) {
    if (kind === "Técnico") {
      assert.equal(
        await page
          .getByRole("button", { name: "+ Técnico", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Editar técnico", exact: true })
          .count(),
        0,
      );
      await pickCatalog(
        page.getByRole("combobox", {
          name: `Profissional ${index + 1}`,
          exact: true,
        }),
        (
          await page.evaluate(
            async () =>
              (await (await fetch("/api/catalog/technicians")).json()).items,
          )
        ).find((t) => t.identifier === identifier).id,
      );
      return;
    }
    await page.getByRole("button", { name: "+ " + kind, exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Cadastro de " + kind });
    await modal.getByLabel("Nome", { exact: true }).fill(name);
    if (identifier) {
      const document = modal.getByLabel(kind === "Cliente" ? "CNPJ" : "CPF", {
        exact: true,
      });
      if (kind === "Técnico")
        assert.equal(await document.getAttribute("inputmode"), "numeric");
      await document.fill(identifier);
      assert.match(
        await document.inputValue(),
        kind === "Cliente"
          ? /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/
          : /^\d{3}\.\d{3}\.\d{3}-\d{2}$/,
      );
    }
    await modal
      .getByRole("button", { name: "Salvar cadastro", exact: true })
      .click();
    await modal.waitFor({ state: "hidden" });
  }
  await catalog("Cliente", "Cliente QA " + tag, "123" + doc);
  const clientId = await page
    .getByLabel("Cliente", { exact: true })
    .getAttribute("data-value");
  let searchRequests = 0;
  const countSearch = (request) => {
    if (request.method() === "GET" && request.url().includes("/api/catalog/"))
      searchRequests++;
  };
  page.on("request", countSearch);
  const clientSearch = page.getByLabel("Cliente", { exact: true });
  await clientSearch.fill("cliente qa " + tag.toLowerCase());
  const listId = await clientSearch.getAttribute("aria-controls");
  assert.equal(
    await page.locator('[id="' + listId + '"] [role="option"]').count(),
    1,
  );
  await clientSearch.press("Enter");
  assert.equal(await clientSearch.getAttribute("data-value"), clientId);
  assert.equal(
    searchRequests,
    0,
    "Digitação no autocomplete não consulta a API",
  );
  page.off("request", countSearch);
  await page.getByRole("button", { name: "+ Veículo", exact: true }).click();
  const vehicleModal = page.getByRole("dialog", {
    name: "Cadastro de Veículo",
    exact: true,
  });
  await vehicleModal
    .getByRole("button", { name: "+ Locadora", exact: true })
    .click();
  const rentalModal = page.getByRole("dialog", {
    name: "Cadastro de Locadora",
    exact: true,
  });
  await rentalModal
    .getByLabel("Nome", { exact: true })
    .fill("Locadora QA " + tag);
  await rentalModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await rentalModal.waitFor({ state: "hidden" });
  assert.ok(
    await vehicleModal.getByLabel("Locadora", { exact: true }).inputValue(),
  );
  await vehicleModal
    .getByLabel("Placa", { exact: true })
    .fill("qa-" + tag.toLowerCase());
  const saveVehicle = vehicleModal.getByRole("button", {
    name: "Salvar cadastro",
    exact: true,
  });
  await saveVehicle.click();
  await vehicleModal.waitFor({ state: "hidden" });
  const vehicleId = await page
    .getByLabel("Veículo", { exact: true })
    .getAttribute("data-value");
  assert.ok(vehicleId);
  await page
    .getByRole("button", { name: "Editar veículo", exact: true })
    .click();
  await vehicleModal
    .getByLabel("Modelo (opcional)", { exact: true })
    .fill("Furgão teste");
  await vehicleModal
    .getByLabel("Cor (opcional)", { exact: true })
    .fill("Branco");
  await saveVehicle.click();
  await vehicleModal.waitFor({ state: "hidden" });
  assert.match(
    await page.getByLabel("Veículo", { exact: true }).inputValue(),
    /FURGÃO TESTE/,
  );
  // Entering identification with only the team missing opens the first professional.
  await page
    .getByRole("button", { name: "A. Identificação", exact: true })
    .click();
  await openSection("A. Identificação");
  await page.locator('input[aria-label="Profissional 1"]:focus').waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Equipe do atendimento", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await openSection(...teamPath, "Profissional 1");
  await catalog("Técnico", "Técnico QA " + tag, doc);
  const firstTech = await page
    .locator('input[aria-label="Profissional 1"]')
    .getAttribute("data-value");
  await page
    .getByLabel("Serviço cobrado do profissional 1", { exact: true })
    .selectOption("Sim");
  await page
    .getByRole("button", { name: "+ Adicionar profissional", exact: true })
    .click();
  await openSection("B. Equipamento");
  await openSection("A. Identificação");
  await page.locator('input[aria-label="Profissional 2"]:focus').waitFor();
  await catalog(
    "Técnico",
    "Segundo técnico QA " + tag,
    String(Number(doc) + 1).padStart(11, "0"),
    1,
  );
  const secondTech = await page
    .locator('input[aria-label="Profissional 2"]')
    .getAttribute("data-value");
  await page
    .getByLabel("Serviço cobrado do profissional 2", { exact: true })
    .selectOption("Não");
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
  await page
    .getByLabel("Serviço cobrado do profissional 3", { exact: true })
    .selectOption("Sim");
  assert.equal(
    await page
      .locator('input[aria-label="Profissional 3"]')
      .locator("..")
      .locator(`[role="option"][data-value="${firstTech}"]`)
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
  assert.equal(
    await page
      .getByRole("button", { name: "Editar técnico", exact: true })
      .count(),
    0,
  );
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
  const equipmentSearch = eqSection.getByLabel("Equipamento", { exact: true });
  await equipmentSearch.click();
  assert.equal(
    await eqSection.getByRole("option").count(),
    1,
    "Novo cliente não pode listar equipamentos de outros clientes",
  );
  await equipmentSearch.press("Escape");
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
  for (const label of ["KM", "Hor. Inferior", "Hor. Superior"]) {
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
  assert.equal(
    await equipmentModal
      .getByLabel("Capacidade nominal", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await eqSection.getByLabel("Capacidade nominal", { exact: true }).count(),
    0,
  );
  assert.equal(
    await equipmentModal.getByLabel("Nome", { exact: true }).count(),
    0,
  );
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
  assert.equal(
    await equipmentModal
      .getByLabel("Ano de fabricação", { exact: true })
      .getAttribute("inputmode"),
    "numeric",
  );
  await equipmentModal
    .getByRole("button", { name: "Não se aplica: Placa", exact: true })
    .click();
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  const equipmentId = await page
    .getByLabel("Equipamento", { exact: true })
    .getAttribute("data-value");
  assert.ok(equipmentId);
  assert.equal(
    await eqSection.getByLabel("Marca", { exact: true }).inputValue(),
    "LIEBHERR",
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
  await eqSection.getByLabel("KM", { exact: true }).fill("-1");
  await eqSection.getByRole("alert").waitFor();
  await eqSection.getByLabel("KM", { exact: true }).fill("500");
  assert.equal(await eqSection.getByRole("alert").count(), 0);
  await eqSection.getByLabel("Hor. Inferior", { exact: true }).fill("25");
  for (const label of ["KM", "Hor. Inferior", "Hor. Superior"])
    assert.equal(
      await eqSection
        .getByLabel(label, { exact: true })
        .getAttribute("inputmode"),
      "decimal",
    );
  await eqSection
    .getByRole("button", {
      name: "Não se aplica: Hor. Superior",
      exact: true,
    })
    .click();
  assert.equal(
    await eqSection.getByLabel("KM", { exact: true }).inputValue(),
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
  assert.equal(
    await equipmentModal
      .getByLabel("Capacidade nominal", { exact: true })
      .count(),
    0,
  );
  const equipmentUpdate = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/catalog/equipment/" + equipmentId) &&
      request.method() === "PUT",
  );
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  assert.equal(
    "nominalCapacity" in (await equipmentUpdate).postDataJSON().data,
    false,
  );
  assert.equal(
    await eqSection.getByLabel("Modelo", { exact: true }).inputValue(),
    "LTM REVISADO " + tag,
  );
  assert.equal(
    await eqSection.getByLabel("KM", { exact: true }).inputValue(),
    "500",
  );
  const updatedEquipment = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/catalog/equipment")).json()).items.find(
        (i) => i.id === id,
      ),
    equipmentId,
  );
  assert.equal(updatedEquipment.data.model, "LTM REVISADO " + tag);
  assert.equal(
    await eqSection.getByLabel("Equipamento", { exact: true }).inputValue(),
    `LTM REVISADO ${tag} - SER-${tag}`,
  );
  await eqSection.getByLabel("Operador", { exact: true }).fill("Operador QA");
  assert.equal(
    await eqSection.getByLabel("Operador", { exact: true }).inputValue(),
    "OPERADOR QA",
  );
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
    await eqSection
      .getByLabel("Equipamento", { exact: true })
      .getAttribute("data-value"),
    equipmentId,
  );
  assert.equal(
    await eqSection.getByLabel("KM", { exact: true }).inputValue(),
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
  assert.equal(
    await page
      .locator('[data-fold="A"]')
      .getByLabel("Operador", { exact: true })
      .count(),
    0,
  );
  await page.getByLabel("Solicitante", { exact: true }).fill("Solicitante QA");
  await page.getByLabel("Solicitante", { exact: true }).press("Enter");
  assert.equal(
    await page
      .getByLabel("Local", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Local", { exact: true }).focus();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.getByLabel("Local", { exact: true }).press("Tab");
  await page.waitForTimeout(150);
  await page.locator('input[aria-label="Profissional 1"]:focus').waitFor();
  assert.equal(
    await page
      .locator('input[aria-label="Profissional 1"]')
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Solicitante", { exact: true }).click();
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
  await page.locator('input[aria-label="Equipamento"]:focus').waitFor();
  assert.equal(
    await page
      .getByLabel("Equipamento", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await openSection("C. Descrição do serviço");
  await page.getByRole("button", { name: "+ Motivo", exact: true }).click();
  const reasonDescription = page.getByRole("textbox", {
    name: "Descrição do motivo",
    exact: true,
  });
  await reasonDescription.fill("Falha intermitente no conjunto");
  assert.equal(await reasonDescription.getAttribute("autocapitalize"), "none");
  const reasonFields = await reasonDescription
    .locator("..")
    .locator("..")
    .locator("textarea")
    .evaluateAll((fields) =>
      fields.map((field) => field.getAttribute("aria-label")),
    );
  assert.deepEqual(reasonFields.slice(0, 2), [
    "Descrição do motivo",
    "Serviço realizado",
  ]);
  assert.equal(
    await page
      .getByRole("button", { name: "Serviço realizado", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Serviço realizado 1", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("textbox", { name: "Serviço realizado", exact: true })
    .fill("Verificação e ajuste do conjunto");
  assert.equal(
    await reasonDescription.inputValue(),
    "Falha intermitente no conjunto",
  );
  await reasonDescription.fill("Falha intermitente no conjunto revisada");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Serviço realizado", exact: true })
      .inputValue(),
    "Verificação e ajuste do conjunto",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Serviço realizado", exact: true })
      .getAttribute("autocapitalize"),
    "none",
  );
  await page
    .getByLabel("Observações do serviço", { exact: true })
    .fill("Verifique na revisão: peça e cabo sem avarias.");
  assert.equal(
    await page
      .getByLabel("Observações do serviço", { exact: true })
      .inputValue(),
    "Verifique na revisão: peça e cabo sem avarias.",
  );
  await page
    .getByLabel("Pendências / próximos passos deste motivo", { exact: true })
    .fill("Agendar retorno após confirmação do cliente.");
  assert.equal(
    await page
      .getByLabel("Pendências / próximos passos deste motivo", { exact: true })
      .inputValue(),
    "Agendar retorno após confirmação do cliente.",
  );
  assert.equal(
    await page
      .getByLabel("Pendências / próximos passos deste motivo", { exact: true })
      .getAttribute("autocapitalize"),
    "none",
  );
  await page
    .getByLabel("Serviço concluído?", { exact: true })
    .selectOption("Sim");
  const completedBox = await page
    .getByLabel("Serviço concluído?", { exact: true })
    .boundingBox();
  const photoButtonBox = await page
    .locator(".br-compact-completed + .br-photos .br-photo-action")
    .last()
    .boundingBox();
  assert.equal(
    Math.round(completedBox.width),
    Math.round(photoButtonBox.width),
  );
  async function assertPhotoActionSpacing() {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      // Wait for responsive layout/scroll anchoring before measuring both
      // controls in the same frame; separate round trips can see different scrolls.
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      const add = await page
        .getByLabel("Adicionar fotos", { exact: true })
        .locator("..")
        .elementHandle();
      const remove = await page
        .getByRole("button", { name: "Remover motivo", exact: true })
        .elementHandle();
      const gap = await page.evaluate(
        ([add, remove]) =>
          remove.getBoundingClientRect().top -
          add.getBoundingClientRect().bottom,
        [add, remove],
      );
      assert.ok(
        gap >= 11.5,
        "Ações de foto e remoção precisam de pelo menos 12px de separação",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await assertPhotoActionSpacing();
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
  await assertPhotoActionSpacing();
  const servicePath = await page
    .locator('[data-fold][data-open="true"]')
    .evaluateAll((els) => els.map((el) => el.dataset.fold));
  await page
    .getByRole("heading", {
      name: "Atendimento técnico QA-AT-" + tag,
      exact: true,
    })
    .click();
  await page.getByLabel("O.S. OMIE", { exact: true }).click();
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
      name: "C. Descrição do serviço",
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
  await openSection("C. Descrição do serviço", "Motivo 1");
  // Changing sections collapses the old branch without discarding its service.
  await openSection("A. Identificação");
  assert.equal(
    await page
      .getByRole("button", {
        name: "C. Descrição do serviço",
        exact: true,
      })
      .getAttribute("aria-expanded"),
    "false",
  );
  await openSection("C. Descrição do serviço", "Motivo 1");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Serviço realizado", exact: true })
      .inputValue(),
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
    .getByRole("textbox", { name: "Serviço realizado", exact: true })
    .fill("Segundo motivo, outro serviço");
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
    .getAttribute("data-value");
  assert.ok(partId);
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "PEÇA DE TESTE",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "FORNECEDOR QA",
  );
  await page.getByLabel("Quantidade", { exact: true }).fill("0");
  assert.equal(
    await page.locator('[data-fold="D"]').getAttribute("data-status"),
    "invalid",
  );
  await page.getByLabel("Quantidade", { exact: true }).fill("2");
  assert.equal(
    await page
      .getByLabel("Quantidade", { exact: true })
      .getAttribute("inputmode"),
    "decimal",
  );
  await page
    .getByLabel("Tipo de aplicação", { exact: true })
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
    await page.getByLabel("Tipo de aplicação", { exact: true }).inputValue(),
    "replaced",
  );
  assert.equal(
    await page.getByLabel("Código da peça", { exact: true }).inputValue(),
    ("PECA-REV-" + tag).toUpperCase(),
  );
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "PEÇA REVISADA",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "FORNECEDOR REVISADO",
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
  await pickCatalog(secondPart, partId);
  assert.equal(
    await page
      .getByLabel("Descrição da peça", { exact: true })
      .last()
      .inputValue(),
    "PEÇA REVISADA",
  );
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).last().inputValue(),
    "1",
  );
  assert.equal(
    await page
      .getByLabel("Tipo de aplicação", { exact: true })
      .last()
      .inputValue(),
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
  await openSection("TÉCNICO QA " + tag);
  assert.equal(await page.getByLabel("KM inicial", { exact: true }).count(), 0);
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
  await assertSameDayEnd(work, "08:00", "17:00");
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
  await work.getByLabel("KM inicial", { exact: true }).fill("100");
  await work.getByLabel("KM final", { exact: true }).fill("125");
  for (const label of ["KM inicial", "KM final", "Pausa em minutos (opcional)"])
    assert.equal(
      await work.getByLabel(label, { exact: true }).getAttribute("inputmode"),
      "decimal",
    );
  for (const label of [
    "Início: hora",
    "Início: minuto",
    "Fim: hora",
    "Fim: minuto",
  ])
    assert.equal(
      await work.getByLabel(label, { exact: true }).getAttribute("inputmode"),
      "numeric",
    );
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
      await panel.getByLabel(label + ": hora", { exact: true }).focus();
      await panel.getByLabel(label + ": hora", { exact: true }).fill("");
      await panel
        .getByLabel(label + ": hora", { exact: true })
        .fill(value.slice(0, 2));
      await panel.getByLabel(label + ": minuto", { exact: true }).focus();
      await panel
        .getByLabel(label + ": minuto", { exact: true })
        .fill(value.slice(3));
      assert.equal(
        await panel.getByLabel(label + ": hora", { exact: true }).inputValue(),
        value.slice(0, 2),
      );
      assert.equal(
        await panel
          .getByLabel(label + ": minuto", { exact: true })
          .inputValue(),
        value.slice(3),
      );
      await panel
        .getByLabel(label + ": minuto", { exact: true })
        .press("Escape");
    }
    await panel
      .getByLabel("Pausa em minutos (opcional)", { exact: true })
      .fill(pause);
    for (const label of ["KM inicial", "KM final"])
      if (
        (await panel.getByLabel(label, { exact: true }).inputValue()) !== "N/A"
      )
        await panel
          .getByRole("button", { name: "Não se aplica: " + label, exact: true })
          .click();
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
      "8h45min de trabalho · 2h45min de deslocamento · 25 km",
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
      name: "SEGUNDO TÉCNICO QA " + tag + " (Técnico)",
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
      "17h30min de trabalho · 5h30min de deslocamento · 25 km",
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
      "14h30min de trabalho · 5h30min de deslocamento · 25 km",
    ),
  );
  await attendance
    .getByRole("checkbox", {
      name: "TÉCNICO QA " + tag + " (Técnico)",
      exact: true,
    })
    .uncheck();
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "5h45min de trabalho · 2h45min de deslocamento · 25 km",
    ),
  );
  assert.equal(
    await attendance.getByRole("checkbox", { checked: true }).count(),
    1,
  );
  await openSection("SEGUNDO TÉCNICO QA " + tag);
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
      name: "TÉCNICO QA " + tag + " (Técnico)",
      exact: true,
    })
    .check();
  await attendance
    .getByRole("checkbox", {
      name: "SEGUNDO TÉCNICO QA " + tag + " (Técnico)",
      exact: true,
    })
    .uncheck();
  await openSection("TÉCNICO QA " + tag);
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "8h45min de trabalho · 2h45min de deslocamento · 25 km",
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
  await openSection("TÉCNICO QA " + tag);
  await openSection("Trabalho", "Trabalho 1");
  assert.equal(
    await work.getByLabel("KM final", { exact: true }).inputValue(),
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
    assert.equal(layout.length, 2);
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
  for (const label of ["Atendimento concluído", "Equipamento liberado"])
    await page
      .getByRole("group", { name: label, exact: true })
      .getByRole("radio", { name: "Sim", exact: true })
      .check();
  assert.equal(
    await page
      .getByRole("group", { name: "Fotos enviadas", exact: true })
      .count(),
    0,
  );
  async function sign(label, signerName, exerciseLayout = false) {
    const card = page
      .locator(".br-signature")
      .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "Assinar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await dialog.waitFor();
    if (exerciseLayout) {
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
    await dialog
      .getByLabel("Nome de quem assinou", { exact: true })
      .fill(signerName);
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
    const captured = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/media") &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await card.getByAltText(label + " salva", { exact: true }).waitFor();
    const caption = await card.locator(".br-signature-caption").innerText();
    assert.ok(caption.includes(signerName.toUpperCase()));
    assert.match(caption, /\d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    return (await (await captured).json()).media;
  }
  const techSigned = await sign(
    "Assinatura do técnico",
    "Técnico assina",
    true,
  );
  const clientSigned = await sign("Assinatura do cliente", "Representante QA");
  const clientResigned = await sign(
    "Assinatura do cliente",
    "Representante QA revisado",
  );
  assert.notEqual(clientSigned.captureId, clientResigned.captureId);
  assert.ok(
    clientResigned.createdAt > clientSigned.createdAt &&
      clientSigned.createdAt > techSigned.createdAt,
  );
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
  const reportDownload = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Finalizar atendimento?", exact: true })
    .getByRole("button", { name: "Finalizar e baixar PDF", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "finalizado" }).waitFor();
  const downloadedReport = await reportDownload;
  assert.equal(
    downloadedReport.suggestedFilename(),
    `CLIENTE-QA-${tag}-QA-AT-${tag}.pdf`,
  );
  await downloadedReport.saveAs(path.join(output, "atendimento.pdf"));
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
  assert.equal(
    await reportSummary.locator("h2 + p + p").innerText(),
    "Finalizado",
  );
  for (const title of [
    "A. Identificação",
    "B. Equipamento",
    "C. Descrição do serviço",
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
  assert.ok((await reportSummary.innerText()).includes("LTM REVISADO " + tag));
  assert.ok(!(await reportSummary.innerText()).includes("Capacidade nominal"));
  for (const text of [
    "Falha intermitente no conjunto revisada",
    "Verifique na revisão: peça e cabo sem avarias.",
    "Agendar retorno após confirmação do cliente.",
  ])
    assert.ok(
      (await reportSummary.innerText()).includes(text),
      "Preserva a capitalização do motivo/serviço após salvar",
    );
  for (const label of [
    "Deslocamento de ida 2",
    "Trabalho 2",
    "Deslocamento de volta 2",
    "8h45min de trabalho · 2h45min de deslocamento · 25 km",
  ])
    assert.ok((await reportSummary.innerText()).includes(label));
  assert.ok(
    (await reportSummary.innerText()).includes(
      "TRÂNSITO INTENSO NA BR-381; ATRASO DE 2H NO RETORNO.",
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
    await page.getByLabel("Descrição do motivo", { exact: true }).inputValue(),
    "Falha intermitente no conjunto revisada",
  );
  assert.equal(
    await page.getByLabel("Serviço realizado", { exact: true }).inputValue(),
    "Verificação e ajuste do conjunto",
  );
  assert.equal(
    await page
      .getByLabel("Peça do catálogo", { exact: true })
      .getAttribute("data-value"),
    partId,
  );
  assert.equal(
    await page.getByLabel("Descrição da peça", { exact: true }).inputValue(),
    "PEÇA REVISADA",
  );
  assert.equal(
    await page.getByLabel("Fornecedor", { exact: true }).inputValue(),
    "FORNECEDOR REVISADO",
  );
  assert.equal(
    await page.getByLabel("Quantidade", { exact: true }).inputValue(),
    "2",
  );
  assert.equal(
    await page.getByLabel("Tipo de aplicação", { exact: true }).inputValue(),
    "replaced",
  );
  assert.equal(
    await page
      .locator('input[aria-label="Profissional 2"]')
      .getAttribute("data-value"),
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
  await openSection("E. Cronograma de atendimento", "Dia 1");
  await page
    .getByRole("button", { name: "Abrir calendário: Data do dia", exact: true })
    .click();
  const calendarBox = await page
    .getByRole("dialog", { name: "Calendário: Data do dia", exact: true })
    .boundingBox();
  assert.ok(calendarBox.x >= 0 && calendarBox.x + calendarBox.width <= 390);
  await page.screenshot({
    path: path.join(output, "calendario-responsivo.png"),
  });
  await page.getByLabel("Data do dia: dia", { exact: true }).press("Escape");
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
    await page
      .locator('input[aria-label="Profissional 1"]')
      .getAttribute("data-value"),
    secondTech,
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .inputValue(),
    "auxiliary",
  );
  assert.equal(
    await page
      .getByLabel("Função do profissional 1", { exact: true })
      .isDisabled(),
    false,
  );
  assert.equal(
    await page.getByLabel("Local", { exact: true }).inputValue(),
    "OFICINA BR LIFT",
  );
  assert.equal(
    await page.getByLabel("KM", { exact: true }).inputValue(),
    "500",
  );
  assert.equal(
    await page.getByLabel("Hor. Inferior", { exact: true }).inputValue(),
    "25",
  );
  assert.equal(
    await page.getByLabel("Hor. Superior", { exact: true }).inputValue(),
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
      name: "SEGUNDO TÉCNICO QA " + tag + " (Auxiliar)",
      exact: true,
    })
    .check();
  assert.ok(
    (await page.locator('[data-fold="E"]').innerText()).includes(
      "5h45min de trabalho",
    ),
  );
  await page
    .getByRole("button", { name: "Finalizar atendimento", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Finalizar atendimento?", exact: true })
    .getByRole("button", { name: "Só finalizar", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "finalizado" }).waitFor();
  await page.getByRole("button", { name: "Inspeções", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Nova inspeção", exact: true })
    .click();
  await page.getByLabel("O.S. OMIE", { exact: true }).fill("QA-IN-" + tag);
  await pickCatalog(page.getByLabel("Cliente", { exact: true }), clientId);
  await pickCatalog(
    page.getByLabel("Inspeção realizada por", { exact: true }),
    firstTech,
  );
  await pickCatalog(page.getByLabel("Veículo", { exact: true }), vehicleId);
  await pickCatalog(
    page.getByLabel("Equipamento", { exact: true }),
    equipmentId,
  );
  for (const label of ["DATA DE VISTORIA", "PRÓXIMA VISTORIA"]) {
    await page
      .getByRole("button", { name: "Abrir calendário: " + label, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Calendário: " + label, exact: true })
      .getByRole("button", { name: "Hoje", exact: true })
      .click();
  }
  const identity = page.locator('[data-fold="A"]');
  assert.equal(
    await identity.getByLabel("CAPACIDADE NOMINAL", { exact: true }).count(),
    1,
  );
  await identity
    .getByRole("button", { name: "Editar equipamento", exact: true })
    .click();
  assert.equal(
    await equipmentModal
      .getByLabel("Capacidade nominal", { exact: true })
      .count(),
    1,
  );
  await equipmentModal
    .getByLabel("Capacidade nominal", { exact: true })
    .fill("80 t");
  await equipmentModal.getByLabel("Placa", { exact: true }).fill("ABC1D23");
  await equipmentModal.getByLabel("Frota", { exact: true }).fill("FROTA-009");
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  assert.equal(
    await identity
      .getByLabel("CAPACIDADE NOMINAL", { exact: true })
      .inputValue(),
    "80 T",
  );
  assert.equal(
    await identity.getByLabel("Placa", { exact: true }).inputValue(),
    "ABC1D23",
  );
  assert.equal(
    await identity.getByLabel("Frota", { exact: true }).inputValue(),
    "FROTA-009",
  );
  assert.equal(
    await identity.getByLabel("Marca", { exact: true }).inputValue(),
    "LIEBHERR",
  );
  assert.equal(
    await identity.getByLabel("RESULTADO DA VISTORIA", { exact: true }).count(),
    0,
  );
  assert.equal(
    await identity.getByLabel("Inspeção aprovada por", { exact: true }).count(),
    0,
  );
  assert.equal(
    await identity
      .getByLabel("MODELO DO GUINDASTE", { exact: true })
      .isDisabled(),
    true,
  );
  await identity.getByLabel("KM", { exact: true }).fill("0");
  await identity.getByLabel("Hor. Inferior", { exact: true }).fill("27");
  await identity
    .getByRole("button", { name: "Não se aplica: Hor. Superior", exact: true })
    .click();
  await openSection("Cronograma de atendimento");
  await page
    .getByRole("button", { name: "+ Dia de inspeção", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("group", { name: "Quem trabalhou neste dia?", exact: true })
      .count(),
    0,
  );
  await page
    .getByLabel("Observações do dia", { exact: true })
    .fill("Vistoria em campo");
  await addPeriod("Deslocamento de ida", "Ida", 1, "07:00", "08:00");
  await addPeriod("Trabalho", "Trabalho", 1, "08:00", "10:00", "15");
  await assertSameDayEnd(
    page
      .getByRole("heading", { name: "Trabalho 1", exact: true })
      .locator(".."),
    "08:00",
    "10:00",
  );
  const inspectionSections = createTemplateSections();
  const titleFor = (item) => `${item.code} — ${item.name}`;
  await openSection("Checklist técnico");
  await page.getByRole("button", { name: /Modo lista/ }).click();
  const firstSection = inspectionSections[0];
  // Existing answers must be skipped by the guided flow.
  for (const item of [firstSection.items[0], firstSection.items[2]]) {
    await openSection("Checklist técnico", firstSection.name, titleFor(item));
    await page
      .getByRole("group", { name: "Situação " + item.code, exact: true })
      .getByRole("button", { name: "A", exact: true })
      .click();
  }
  await page.getByRole("button", { name: /Pergunta a pergunta/ }).click();
  const guided = page.getByRole("dialog", {
    name: titleFor(firstSection.items[1]),
    exact: true,
  });
  await guided.waitFor();
  await guided
    .getByRole("group", {
      name: "Situação " + firstSection.items[1].code,
      exact: true,
    })
    .getByRole("button")
    .first()
    .click();
  await guided
    .getByRole("button", { name: "Próximo pendente →", exact: true })
    .click();
  const nextGuided = page.getByRole("dialog", {
    name: titleFor(inspectionSections[1].items[0]),
    exact: true,
  });
  await nextGuided.waitFor();
  await nextGuided
    .getByRole("button", {
      name: "Voltar ao checklist em modo lista",
      exact: true,
    })
    .click();
  for (const section of inspectionSections) {
    for (const item of section.items) {
      await openSection("Checklist técnico", section.name, titleFor(item));
      const answer = page
        .getByRole("group", { name: "Situação " + item.code, exact: true })
        .getByRole("button", { name: "A", exact: true });
      if ((await answer.getAttribute("aria-pressed")) !== "true")
        await answer.click();
    }
  }
  await page.getByLabel("Somente pendentes", { exact: true }).check();
  await page.getByText("Nenhum item encontrado.", { exact: true }).waitFor();
  await page.getByLabel("Somente pendentes", { exact: true }).uncheck();
  await openSection(
    "Checklist técnico",
    firstSection.name,
    titleFor(firstSection.items[0]),
  );
  const firstItemPanel = page
    .getByRole("heading", {
      name: titleFor(firstSection.items[0]),
      exact: true,
    })
    .locator("..");
  await firstItemPanel
    .getByLabel("Observações do item", { exact: true })
    .fill("Conferido presencialmente");
  await firstItemPanel
    .getByLabel("Adicionar fotos", { exact: true })
    .setInputFiles([
      { name: "inspecao-1.png", mimeType: "image/png", buffer: photo },
      { name: "inspecao-2.png", mimeType: "image/png", buffer: photo },
    ]);
  await page.getByAltText("inspecao-2.png", { exact: true }).waitFor();
  const extraSection = inspectionSections.find((section) =>
    section.items.some((item) => item.code === "126"),
  );
  const extraItem = extraSection.items.find((item) => item.code === "126");
  await openSection(
    "Checklist técnico",
    extraSection.name,
    titleFor(extraItem),
  );
  const extra = page
    .getByRole("heading", { name: titleFor(extraItem), exact: true })
    .locator("..");
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
  await openSection("Assinatura e finalização");
  await page
    .getByLabel("RESULTADO DA VISTORIA", { exact: true })
    .selectOption("Aprovada");
  await pickCatalog(
    page.getByLabel("Inspeção aprovada por", { exact: true }),
    secondTech,
  );
  await sign("Assinatura do técnico", "Inspetor QA");
  await sign("Assinatura do cliente", "Cliente da inspeção");
  await page
    .getByRole("button", { name: "Finalizar inspeção", exact: true })
    .click();
  const inspectionDownload = page.waitForEvent("download");
  await page
    .getByRole("dialog", { name: "Finalizar inspeção?", exact: true })
    .getByRole("button", { name: "Finalizar e baixar PDF", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "finalizado" }).waitFor();
  const downloadedInspection = await inspectionDownload;
  assert.equal(
    downloadedInspection.suggestedFilename(),
    `CLIENTE-QA-${tag}-QA-IN-${tag}.pdf`,
  );
  await downloadedInspection.saveAs(path.join(output, "inspecao.pdf"));
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
  const docxBytes = await page.evaluate(async (number) => {
    const entry = (
      await (
        await fetch("/api/inspections?q=" + encodeURIComponent(number))
      ).json()
    ).items[0];
    const response = await fetch(
      "/api/inspections/" + entry.id + "/document/docx",
    );
    if (!response.ok)
      throw Error("Falha no DOCX da inspeção: " + response.status);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, "QA-IN-" + tag);
  await fs.writeFile(
    path.join(output, "inspecao.docx"),
    Buffer.from(docxBytes),
  );
  const inspectionDocx = await JSZip.loadAsync(Buffer.from(docxBytes));
  const inspectionXml = await inspectionDocx
    .file("word/document.xml")
    .async("string");
  for (const value of [
    "CLIENTE QA " + tag,
    "LIEBHERR",
    "ABC1D23",
    "FROTA-009",
    "RESUMO DO CRONOGRAMA",
  ])
    assert.ok(inspectionXml.includes(value), value);
  assert.match(
    inspectionXml,
    /Trabalho líquido: 1h45min · Deslocamento líquido: 1h00min · Quilometragem total: 0/,
  );
  assert.doesNotMatch(inspectionXml, /\bCPF\b|GUINDASTE – Guindaste/);
  assert.ok(
    Object.keys(inspectionDocx.files).some((name) =>
      name.includes("stg-img_126_1-"),
    ),
    "Foto complementar entra no documento final",
  );
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
  // Editing equipment from a technical report must not erase the shared
  // capacity previously registered through the inspection workflow.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Relatório Técnico", exact: true })
    .click();
  await page
    .getByRole("button", { name: "+ Novo atendimento", exact: true })
    .click();
  await pickCatalog(page.getByLabel("Cliente", { exact: true }), clientId);
  await openSection("B. Equipamento");
  await pickCatalog(
    page.getByLabel("Equipamento", { exact: true }),
    equipmentId,
  );
  assert.equal(
    await page.getByLabel("Capacidade nominal", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Editar equipamento", exact: true })
    .click();
  assert.equal(
    await equipmentModal
      .getByLabel("Capacidade nominal", { exact: true })
      .count(),
    0,
  );
  await equipmentModal
    .getByRole("button", { name: "Salvar cadastro", exact: true })
    .click();
  await equipmentModal.waitFor({ state: "hidden" });
  const preservedEquipment = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/catalog/equipment")).json()).items.find(
        (item) => item.id === id,
      ),
    equipmentId,
  );
  assert.equal(preservedEquipment.data.nominalCapacity, "80 T");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cadastros", exact: true }).click();
  const basicUser = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/users")).json()).users.find(
        (u) => u.technician?.id === id,
      ),
    basicTechnician.id,
  );
  assert.ok(basicUser && basicUser.hasAccess === false);
  const basicCard = page
    .locator(".br-user-card")
    .filter({ has: page.getByText(basicUser.name, { exact: true }) });
  await basicCard
    .getByText("Sem acesso ao sistema — cadastro básico", { exact: true })
    .waitFor();
  await basicCard.getByRole("button", { name: "Editar", exact: true }).click();
  const basicDialog = page.getByRole("dialog");
  assert.equal(
    await basicDialog
      .getByLabel("E-mail de acesso", { exact: true })
      .inputValue(),
    "",
  );
  assert.equal(
    await basicDialog
      .getByLabel("E-mail de acesso", { exact: true })
      .getAttribute("required"),
    null,
  );
  await basicDialog
    .getByRole("button", { name: "Cancelar", exact: true })
    .click();
  // Validate the actual technician UI, not only permission helper functions.
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page
    .getByLabel("E-mail", { exact: true })
    .fill(`team-0-${tag.toLowerCase()}@example.test`);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Novo atendimento", exact: true })
    .click();
  assert.equal(
    await page.getByRole("button", { name: "Cadastros", exact: true }).count(),
    0,
  );
  await pickCatalog(page.getByLabel("Cliente", { exact: true }), clientId);
  assert.equal(
    await page
      .getByRole("button", { name: "Editar cliente", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Excluir", exact: true }).count(),
    0,
  );
  await catalog(
    "Cliente",
    "Primeiro do técnico " + tag,
    "123" + String(Number(doc) + 5),
  );
  const firstOwnClient = await page
    .getByLabel("Cliente", { exact: true })
    .getAttribute("data-value");
  assert.equal(
    await page
      .getByRole("button", { name: "Editar cliente", exact: true })
      .isEnabled(),
    true,
  );
  await catalog(
    "Cliente",
    "Último do técnico " + tag,
    "123" + String(Number(doc) + 6),
  );
  await pickCatalog(
    page.getByLabel("Cliente", { exact: true }),
    firstOwnClient,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Editar cliente", exact: true })
      .isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "permissoes-tecnico-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSection(...teamPath, "Profissional 1");
  assert.equal(
    await page.getByRole("button", { name: "+ Técnico", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Editar técnico", exact: true })
      .count(),
    0,
  );
  await pickCatalog(
    page.getByRole("combobox", { name: "Profissional 1", exact: true }),
    secondTech,
  );
  await page.getByLabel("O.S. OMIE", { exact: true }).fill("DELEGADO-" + tag);
  await page
    .getByRole("button", { name: "Salvar rascunho", exact: true })
    .click();
  await page
    .getByText(
      "Rascunho salvo para a equipe selecionada. Como você não está vinculado, ele não aparecerá na sua lista.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "+ Novo atendimento", exact: true })
    .waitFor();
  const ownReports = await page.evaluate(
    async () => (await (await fetch("/api/reports")).json()).items,
  );
  assert.ok(!ownReports.some((r) => r.number === "DELEGADO-" + tag));
  await page.getByRole("button", { name: "Inspeções", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Nova inspeção", exact: true })
    .click();
  assert.equal(
    await page.getByRole("button", { name: "+ Técnico", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Editar técnico", exact: true })
      .count(),
    0,
  );
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
