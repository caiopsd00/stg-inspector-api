export function createAttemptLimiter(
  maximum: number,
  windowMs: number,
  maxKeys = 10000,
  clock = Date.now,
) {
  const attempts = new Map<string, { count: number; until: number }>();
  return {
    allow(key: string) {
      const now = clock();
      const existing = attempts.get(key);
      if (existing && existing.until > now) {
        if (existing.count >= maximum) return false;
        existing.count++;
        return true;
      }
      attempts.delete(key);
      if (attempts.size >= maxKeys)
        attempts.delete(attempts.keys().next().value!);
      attempts.set(key, { count: 1, until: now + windowMs });
      return true;
    },
    reset(key: string) { attempts.delete(key); },
  };
}
