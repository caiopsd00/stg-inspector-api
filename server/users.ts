import crypto from "node:crypto";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./auth.js";
import { transaction } from "./db.js";
import { audit, fail } from "./relational-utils.js";

export const userRegistrationSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(300),
  email: z
    .string()
    .trim()
    .email("Informe um e-mail válido.")
    .max(254)
    .transform((value) => value.toLowerCase()),
  cpf: z
    .string()
    .transform((value) => value.replace(/\D/g, ""))
    .refine((value) => value.length === 11, "CPF precisa ter 11 dígitos."),
  password: z
    .string()
    .min(10, "A senha precisa ter no mínimo 10 caracteres.")
    .max(1024),
  role: z.enum(["admin", "technician"]),
});

export type UserRegistration = z.infer<typeof userRegistrationSchema>;

export const userUpdateSchema = userRegistrationSchema
  .omit({ password: true })
  .extend({
    password: z
      .union([
        z.literal(""),
        z
          .string()
          .min(10, "A senha precisa ter no mínimo 10 caracteres.")
          .max(1024),
      ])
      .optional(),
  });

export const profileUpdateSchema = userUpdateSchema
  .omit({ role: true })
  .extend({ currentPassword: z.string().min(1).max(1024) })
  .strict();

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
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "user-email:" + input.email,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "technician-cpf:" + input.cpf,
      ]);
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
      const role: "admin" | "technician" = options.selfService
        ? user.role
        : (input as z.infer<typeof userUpdateSchema>).role;
      const emailOwner = (
        await db.query(
          "SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2",
          [input.email, userId],
        )
      ).rows[0];
      if (emailOwner) throw fail(409, "Já existe um usuário com esse e-mail.");
      if (user.active && user.role === "admin" && role !== "admin") {
        const admins = Number(
          (
            await db.query(
              "SELECT count(*)::int AS count FROM users WHERE active AND role='admin' AND id<>$1",
              [userId],
            )
          ).rows[0].count,
        );
        if (!admins)
          throw fail(
            409,
            "Não é possível remover o perfil do último administrador ativo.",
          );
      }
      const linked = (
        await db.query(
          "SELECT id FROM technicians WHERE user_id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      const matchingCpf = (
        await db.query(
          "SELECT id,user_id FROM technicians WHERE cpf=$1 FOR UPDATE",
          [input.cpf],
        )
      ).rows[0];
      if (matchingCpf?.user_id && matchingCpf.user_id !== userId)
        throw fail(409, "Esse CPF já está vinculado a outro usuário.");
      if (linked && matchingCpf && linked.id !== matchingCpf.id)
        throw fail(
          409,
          "O usuário e o CPF já pertencem a cadastros técnicos diferentes.",
        );

      await db.query(
        "UPDATE users SET email=$2,name=$3,role=$4,password_hash=COALESCE($5,password_hash) WHERE id=$1",
        [userId, input.email, input.name, role, passwordHash],
      );
      if (
        passwordHash ||
        user.email.toLowerCase() !== input.email.toLowerCase()
      ) {
        if (options.currentSessionHash && options.actorUserId === userId)
          await db.query(
            "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
            [userId, options.currentSessionHash],
          );
        else await db.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      }
      let technicianId: string;
      if (linked) {
        technicianId = linked.id;
        await db.query(
          "UPDATE technicians SET name=$2,cpf=$3,active=$4,version=version+1,updated_at=now() WHERE id=$1",
          [technicianId, input.name, input.cpf, user.active],
        );
      } else if (matchingCpf) {
        technicianId = matchingCpf.id;
        await db.query(
          "UPDATE technicians SET user_id=$2,name=$3,active=$4,version=version+1,updated_at=now() WHERE id=$1",
          [technicianId, userId, input.name, user.active],
        );
      } else {
        technicianId = crypto.randomUUID();
        await db.query(
          "INSERT INTO technicians(id,name,cpf,user_id,active) VALUES($1,$2,$3,$4,$5)",
          [technicianId, input.name, input.cpf, userId, user.active],
        );
      }
      await audit(
        db,
        options.actorUserId,
        "users",
        userId,
        options.selfService
          ? "self_update_with_technician"
          : "update_with_technician",
        { email: user.email, name: user.name, role: user.role },
        {
          email: input.email,
          name: input.name,
          role,
          technicianId,
        },
      );
      return {
        user: {
          id: userId,
          email: input.email,
          name: input.name,
          role,
          active: user.active,
        },
        technician: {
          id: technicianId,
          name: input.name,
          identifier: input.cpf,
        },
      };
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
    const user = (
      await db.query(
        "SELECT id,email,name,role,active FROM users WHERE id=$1 FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (!user) throw fail(404, "Usuário não encontrado.");
    if (!active && actorUserId === userId)
      throw fail(409, "Não é possível desativar a própria conta.");
    if (!active && user.active && user.role === "admin") {
      const admins = Number(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM users WHERE active AND role='admin' AND id<>$1",
            [userId],
          )
        ).rows[0].count,
      );
      if (!admins)
        throw fail(
          409,
          "Não é possível desativar o último administrador ativo.",
        );
    }
    await db.query("UPDATE users SET active=$2 WHERE id=$1", [userId, active]);
    await db.query(
      "UPDATE technicians SET active=$2,version=version+1,updated_at=now() WHERE user_id=$1",
      [userId, active],
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
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "user-email:" + input.email,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "technician-cpf:" + input.cpf,
      ]);

      const existingUser = (
        await db.query(
          "SELECT id FROM users WHERE lower(email)=$1 FOR UPDATE",
          [input.email],
        )
      ).rows[0];
      if (existingUser && !options.updateExisting)
        throw fail(409, "Já existe um usuário com esse e-mail.");

      const userId = existingUser?.id || crypto.randomUUID();
      if (existingUser) {
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

      const linked = (
        await db.query(
          "SELECT id FROM technicians WHERE user_id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      const matchingCpf = (
        await db.query(
          "SELECT id,user_id FROM technicians WHERE cpf=$1 FOR UPDATE",
          [input.cpf],
        )
      ).rows[0];
      if (matchingCpf?.user_id && matchingCpf.user_id !== userId)
        throw fail(409, "Esse CPF já está vinculado a outro usuário.");
      if (linked && matchingCpf && linked.id !== matchingCpf.id)
        throw fail(
          409,
          "O usuário e o CPF já pertencem a cadastros técnicos diferentes.",
        );

      let technicianId: string;
      if (linked) {
        technicianId = linked.id;
        await db.query(
          "UPDATE technicians SET name=$2,cpf=$3,active=true,version=version+1,updated_at=now() WHERE id=$1",
          [technicianId, input.name, input.cpf],
        );
      } else if (matchingCpf) {
        technicianId = matchingCpf.id;
        await db.query(
          "UPDATE technicians SET user_id=$2,name=$3,active=true,version=version+1,updated_at=now() WHERE id=$1",
          [technicianId, userId, input.name],
        );
      } else {
        technicianId = crypto.randomUUID();
        await db.query(
          "INSERT INTO technicians(id,name,cpf,user_id) VALUES($1,$2,$3,$4)",
          [technicianId, input.name, input.cpf, userId],
        );
      }

      if (options.actorUserId)
        await audit(
          db,
          options.actorUserId,
          "users",
          userId,
          existingUser ? "update_with_technician" : "create_with_technician",
          null,
          {
            email: input.email,
            name: input.name,
            role: input.role,
            technicianId,
          },
        );

      return {
        user: {
          id: userId,
          email: input.email,
          name: input.name,
          role: input.role,
        },
        technician: {
          id: technicianId,
          name: input.name,
          identifier: input.cpf,
        },
      };
    });
  } catch (error: any) {
    if (error.code === "23505") throw fail(409, "E-mail ou CPF já cadastrado.");
    throw error;
  }
}
