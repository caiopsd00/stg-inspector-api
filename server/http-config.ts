export function httpConfig(env: NodeJS.ProcessEnv = process.env) {
  const allowAllOrigins = env.CORS_ALLOW_ALL_ORIGINS === "true";
  const origins = (env.WEB_ORIGIN || "http://localhost:5174")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (env.NODE_ENV === "production") {
    if (allowAllOrigins) throw Error("CORS aberto não é permitido em produção.");
    if (!env.WEB_ORIGIN || !origins.length)
      throw Error("Defina WEB_ORIGIN em produção.");
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin)
        throw Error("WEB_ORIGIN deve conter apenas origens HTTPS em produção.");
    }
  }
  if (env.TRUST_PROXY && !["0", "1"].includes(env.TRUST_PROXY))
    throw Error("TRUST_PROXY deve ser 0 (direto) ou 1 (um proxy confiável).");
  return { allowAllOrigins, origins, trustProxy: env.TRUST_PROXY === "1" ? 1 : false };
}
