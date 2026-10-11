import { fail } from "../relational-utils.js";
import { profileByUserId, userRows } from "../repositories/users-repository.js";
export {
  createUserAndTechnician,
  setUserActive,
  updateUserAndTechnician,
} from "../users.js";

export async function getProfile(userId: string) {
  const profile = await profileByUserId(userId);
  if (!profile) throw fail(404, "Usuário não encontrado.");
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role,
    cpf: profile.cpf || "",
  };
}

export async function listUsers() {
  const rows = await userRows();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    technician: row.technician_id
      ? {
          id: row.technician_id,
          cpf: row.technician_cpf,
          active: row.technician_active,
        }
      : null,
  }));
}
