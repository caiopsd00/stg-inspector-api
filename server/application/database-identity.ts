import { installationIdentity } from "../repositories/installation-repository.js";

export async function databaseIdentity() {
  return installationIdentity();
}
