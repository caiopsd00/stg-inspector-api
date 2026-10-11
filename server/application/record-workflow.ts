import type { Entry } from "../../contracts/domain.js";
import type { User } from "../auth.js";
import { sha } from "../auth.js";
import { transaction } from "../db.js";
import { validateMediaReferences } from "./media-service.js";
import {
  assertTechnicianCanSave,
  technicianIdForUser,
  type RecordKind,
} from "../repositories/record-access.js";
import type { RecordFilter } from "../repositories/record-query.js";
import type { DB } from "../relational-utils.js";
import type { z } from "zod";
import type { recordInput } from "../validation.js";
import {
  receiptFor,
  saveReceipt,
} from "../repositories/sync-receipt-repository.js";

type SaveInput = z.infer<typeof recordInput>;
type Read = (db: DB, filter: RecordFilter) => Promise<Entry[]>;
type Save = (
  db: DB,
  id: string,
  input: SaveInput,
  userId: string,
) => Promise<Entry>;

export async function listRecordKind(
  user: User,
  filter: RecordFilter,
  read: Read,
) {
  return transaction(async (db) => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const ownTechnicianId =
      user.role === "admin"
        ? null
        : (await technicianIdForUser(db, user)) || "";
    return read(db, {
      ...filter,
      ownTechnicianId,
      technicianId: user.role === "admin" ? filter.technicianId : undefined,
      searchTechnician: user.role === "admin",
    });
  });
}

export async function saveRecordKind(
  kind: RecordKind,
  id: string,
  input: SaveInput,
  user: User,
  save: Save,
) {
  const hash = sha(JSON.stringify({ kind, id, input }));
  return transaction(async (db) => {
    await assertTechnicianCanSave(db, kind, id, input, user);
    const receipt = await receiptFor<Entry>(
      db,
      user.id,
      input.mutationId,
      hash,
    );
    if (receipt) return receipt;
    await validateMediaReferences(db, input.payload, user);
    const saved = await save(db, id, input, user.id);
    await saveReceipt(db, user.id, input.mutationId, hash, saved);
    return saved;
  });
}
