import { fail } from "./relational-utils.js";

export function concurrencySetting(name: string, fallback = 1): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-4]$/.test(value))
    throw Error(`${name} deve ser um inteiro entre 1 e 4.`);
  return Number(value);
}

// Reject excess work instead of retaining an unbounded queue of images/PDFs.
export function createConcurrencyLimit(limit: number, message: string) {
  if (!Number.isInteger(limit) || limit < 1) throw Error("Limite inválido.");
  let active = 0;
  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limit) throw fail(429, message);
    active++;
    try {
      return await operation();
    } finally {
      active--;
    }
  };
}
