import crypto from "node:crypto";
import { z } from "zod";
import {
  canAdminister,
  isTechnician,
  userRoles,
  type UserRole,
} from "../contracts/domain.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { transaction } from "./db.js";
import { audit, fail, type DB } from "./relational-utils.js";

const fields = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(300),
  email: z
    .string()
    .trim()
    .email("Informe um e-mail válido.")
    .max(254)
    .transform((value) => value.toLowerCase()),
  cpf: z
    .string()
    .default("")
    .transform((value) => value.replace(/\D/g, ""))
    .refine(
      (value) => !value || value.length === 11,
      "CPF precisa ter 11 dígitos.",
    ),
  role: z.enum(userRoles),
});
const newPassword = z
  .string()
  .min(10, "A senha precisa ter no mínimo 10 caracteres.")
  .max(1024);
const optionalPassword = z.union([z.literal(""), newPassword]).optional();
function validateRoleCpf(
  input: { role: UserRole; cpf: string },
  ctx: z.RefinementCtx,
) {
  if (isTechnician(input.role) && !input.cpf)
    ctx.addIssue({
      code: "custom",
      path: ["cpf"],
      message: "Informe o CPF do técnico (11 dígitos).",
    });
}
export const userRegistrationSchema = fields
  .extend({ password: newPassword })
  .superRefine(validateRoleCpf);
export type UserRegistration = z.infer<typeof userRegistrationSchema>;
export const userUpdateSchema = fields
  .extend({
    email: z.union([fields.shape.email, z.literal("")]),
    password: optionalPassword,
  })
  .superRefine(validateRoleCpf);
export const profileUpdateSchema = fields
  .omit({ role: true })
  .extend({
    password: optionalPassword,
    currentPassword: z.string().min(1).max(1024),
  })
  .strict();

async function lockAccountChanges(db: DB) {
  // Serialize role/activation changes so two concurrent operations cannot
  // both remove the last active administrative account.
  await db.query("SELECT pg_advisory_xact_lock(917427)");
}
async function assertAnotherAdmin(db: DB, userId: string) {
  if (
    !(
      await db.query(
        "SELECT 1 FROM users WHERE active AND role IN ('admin','technician_admin') AND id<>$1 LIMIT 1",
        [userId],
      )
    ).rowCount
  )
    throw fail(
      409,
      "Não é possível remover o acesso do último administrador ativo.",
    );
}
async function syncTechnicalProfile(
  db: DB,
  userId: string,
  input: { role: UserRole; cpf: string; name: string },
  active: boolean,
) {
  const linked = (
    await db.query("SELECT id FROM technicians WHERE user_id=$1 FOR UPDATE", [
      userId,
    ])
  ).rows[0];
  if (!isTechnician(input.role)) {
    if (linked)
      await db.query(
        "UPDATE technicians SET active=false,version=version+1,updated_at=now() WHERE id=$1 AND active",
        [linked.id],
      );
    return null;
  }
  if (!input.cpf) throw fail(422, "Informe o CPF do técnico (11 dígitos).");
  const matching = (
    await db.query(
      "SELECT id,user_id FROM technicians WHERE cpf=$1 FOR UPDATE",
      [input.cpf],
    )
  ).rows[0];
  if (matching?.user_id && matching.user_id !== userId)
    throw fail(409, "Esse CPF já está vinculado a outro usuário.");
  if (linked && matching && linked.id !== matching.id)
    throw fail(
      409,
      "O usuário e o CPF já pertencem a cadastros técnicos diferentes.",
    );
  const technicianId = linked?.id || matching?.id || crypto.randomUUID();
  if (linked || matching)
    await db.query(
      "UPDATE technicians SET user_id=$2,name=$3,cpf=$4,active=$5,version=version+1,updated_at=now() WHERE id=$1",
      [technicianId, userId, input.name, input.cpf, active],
    );
  else
    await db.query(
      "INSERT INTO technicians(id,user_id,name,cpf,active) VALUES($1,$2,$3,$4,$5)",
      [technicianId, userId, input.name, input.cpf, active],
    );
  return {
    id: technicianId as string,
    name: input.name,
    identifier: input.cpf,
  };
}

export async function updateUserAndTechnician(
  userId: string,
  raw: unknown,
  options: {
    actorUserId: string;
    currentSessionHash?: string;
    selfService?: boolean;
  },
) {
  const input = options.selfService
    ? profileUpdateSchema.parse(raw)
    : userUpdateSchema.parse(raw);
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : null;
  try {
    return await transaction(async (db) => {
      await lockAccountChanges(db);
      const user = (
        await db.query(
          "SELECT id,email,name,role,active,password_hash FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      if (!user) throw fail(404, "Usuário não encontrado.");
      if (options.selfService) {
        if (options.actorUserId !== userId)
          throw fail(403, "Você só pode alterar seu próprio perfil.");
        if (
          !(await verifyPassword(
            (input as z.infer<typeof profileUpdateSchema>).currentPassword,
            user.password_hash,
          ))
        )
          throw fail(401, "Senha atual incorreta.");
      }
      if (
        (!input.email && (user.email || input.password)) ||
        (input.email && !user.password_hash && !passwordHash)
      )
        throw fail(422, "Para liberar acesso, informe e-mail e senha inicial.");
      const role: UserRole = options.selfService
        ? user.role
        : (input as z.infer<typeof userUpdateSchema>).role;
      if (canAdminister(role) && !input.email)
        throw fail(
          422,
          "Administradores precisam de e-mail e senha de acesso.",
        );
      if (user.active && canAdminister(user.role) && !canAdminister(role))
        await assertAnotherAdmin(db, userId);
      await db.query(
        "UPDATE users SET email=$2,name=$3,role=$4,password_hash=COALESCE($5,password_hash) WHERE id=$1",
        [userId, input.email || null, input.name, role, passwordHash],
      );
      if (passwordHash || (user.email || "").toLowerCase() !== input.email) {
        if (options.currentSessionHash && options.actorUserId === userId)
          await db.query(
            "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
            [userId, options.currentSessionHash],
          );
        else await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      }
      const technician = await syncTechnicalProfile(
        db,
        userId,
        { ...input, role },
        user.active,
      );
      const updated = {
        id: userId,
        email: input.email,
        name: input.name,
        role,
        active: user.active,
      };
      await audit(
        db,
        options.actorUserId,
        "users",
        userId,
        options.selfService ? "self_update" : "update",
        { email: user.email, name: user.name, role: user.role },
        { ...updated, technicianId: technician?.id || null },
      );
      return { user: updated, technician };
    });
  } catch (error: any) {
    if (error.code === "23505") throw fail(409, "E-mail ou CPF já cadastrado.");
    throw error;
  }
}

export async function setUserActive(
  userId: string,
  active: boolean,
  actorUserId: string,
) {
  return transaction(async (db) => {
    await lockAccountChanges(db);
    const user = (
      await db.query(
        "SELECT id,email,name,role,active FROM users WHERE id=$1 FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (!user) throw fail(404, "Usuário não encontrado.");
    if (!active && actorUserId === userId)
      throw fail(409, "Não é possível desativar a própria conta.");
    if (!active && user.active && canAdminister(user.role))
      await assertAnotherAdmin(db, userId);
    await db.query("UPDATE users SET active=$2 WHERE id=$1", [userId, active]);
    await db.query(
      "UPDATE technicians SET active=$2,version=version+1,updated_at=now() WHERE user_id=$1",
      [userId, active && isTechnician(user.role)],
    );
    if (!active)
      await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
    await audit(
      db,
      actorUserId,
      "users",
      userId,
      active ? "reactivate" : "deactivate",
      { active: user.active },
      { active },
    );
    return { user: { ...user, active } };
  });
}

export async function createUserAndTechnician(
  raw: unknown,
  options: { updateExisting?: boolean; actorUserId?: string } = {},
) {
  const input = userRegistrationSchema.parse(raw);
  const passwordHash = await hashPassword(input.password);
  try {
    return await transaction(async (db) => {
      await lockAccountChanges(db);
      const existing = (
        await db.query(
          "SELECT id,role,active FROM users WHERE lower(email)=$1 FOR UPDATE",
          [input.email],
        )
      ).rows[0];
      if (existing && !options.updateExisting)
        throw fail(409, "Já existe um usuário com esse e-mail.");
      const userId: string = existing?.id || crypto.randomUUID();
      if (existing) {
        if (
          existing.active &&
          canAdminister(existing.role) &&
          !canAdminister(input.role)
        )
          await assertAnotherAdmin(db, userId);
        await db.query(
          "UPDATE users SET email=$2,name=$3,password_hash=$4,role=$5,active=true WHERE id=$1",
          [userId, input.email, input.name, passwordHash, input.role],
        );
        await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      } else {
        await db.query(
          "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
          [userId, input.email, input.name, passwordHash, input.role],
        );
      }
      const technician = await syncTechnicalProfile(db, userId, input, true);
      const user = {
        id: userId,
        email: input.email,
        name: input.name,
        role: input.role,
      };
      if (options.actorUserId)
        await audit(
          db,
          options.actorUserId,
          "users",
          userId,
          existing ? "update" : "create",
          null,
          { ...user, technicianId: technician?.id || null },
        );
      return { user, technician };
    });
  } catch (error: any) {
    if (error.code === "23505") throw fail(409, "E-mail ou CPF já cadastrado.");
    throw error;
  }
}
