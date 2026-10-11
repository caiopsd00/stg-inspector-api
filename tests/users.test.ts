import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileUpdateSchema,
  userRegistrationSchema,
  userUpdateSchema,
} from "../server/users.js";

test("cadastro normaliza e-mail e CPF e exige campos de acesso e técnico", () => {
  const parsed = userRegistrationSchema.parse({
    name: "  Ana Técnica  ",
    email: "  ANA@EXAMPLE.TEST ",
    cpf: "123.456.789-01",
    password: "senha-segura-123",
    role: "technician",
  });
  assert.equal(parsed.name, "Ana Técnica");
  assert.equal(parsed.email, "ana@example.test");
  assert.equal(parsed.cpf, "12345678901");
  assert.equal(parsed.role, "technician");
});

test("edição permite manter senha vazia, mas valida quando uma nova senha é informada", () => {
  const valid = {
    name: "Caio",
    email: "caio@example.test",
    cpf: "12345678901",
    role: "admin",
  };
  assert.equal(userUpdateSchema.parse(valid).password, undefined);
  assert.equal(userUpdateSchema.parse({ ...valid, password: "" }).password, "");
  assert.equal(
    userUpdateSchema.safeParse({ ...valid, password: "curta" }).success,
    false,
  );
  assert.equal(
    userUpdateSchema.parse({ ...valid, cpf: "123.456.789-01" }).cpf,
    "12345678901",
  );
});

test("cadastro rejeita CPF curto, e-mail inválido, senha curta e perfil desconhecido", () => {
  const valid = {
    name: "Ana",
    email: "ana@example.test",
    cpf: "12345678901",
    password: "senha-segura-123",
    role: "technician",
  };
  for (const patch of [
    { cpf: "123" },
    { email: "inválido" },
    { password: "curta" },
    { role: "diretoria" },
  ])
    assert.equal(
      userRegistrationSchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
});

test("edição do próprio perfil exige senha atual e rejeita alteração de papel", () => {
  const valid = {
    name: "Ana",
    email: "ana@example.test",
    cpf: "123.456.789-01",
    currentPassword: "senha-atual-123",
  };
  assert.equal(profileUpdateSchema.parse(valid).cpf, "12345678901");
  assert.equal(
    profileUpdateSchema.safeParse({ ...valid, role: "admin" }).success,
    false,
  );
  assert.equal(
    profileUpdateSchema.safeParse({ ...valid, currentPassword: "" }).success,
    false,
  );
  assert.equal(
    profileUpdateSchema.safeParse({ ...valid, password: "curta" }).success,
    false,
  );
});
