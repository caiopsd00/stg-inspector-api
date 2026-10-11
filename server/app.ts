import express from "express";
import { z } from "zod";

import { databaseIdentity } from "./application/database-identity.js";
import { requireAuth } from "./auth.js";
import { createAuthRoutes } from "./routes/auth.routes.js";
import { createCatalogRoutes } from "./routes/catalog.routes.js";
import { createDocumentsRoutes } from "./routes/documents.routes.js";
import { createMediaRoutes } from "./routes/media.routes.js";
import { createRecordsRoutes } from "./routes/records.routes.js";
import { createUsersRoutes } from "./routes/users.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  const allowAllOrigins = process.env.CORS_ALLOW_ALL_ORIGINS === "true";
  const origins = (process.env.WEB_ORIGIN || "http://localhost:5174")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    const origin = req.headers.origin;
    if (origin && !allowAllOrigins && !origins.includes(origin)) {
      res.status(403).json({ error: "Origem não autorizada." });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-BRLIFT-Database,X-BRLIFT-Contract",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16mb" }));
  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      service: "brlift-api",
      ...(await databaseIdentity()),
    });
  });

  const authRoutes = createAuthRoutes();
  app.use("/api/auth", authRoutes.publicRoutes);
  app.use("/api", requireAuth);
  app.use("/api/auth", authRoutes.privateRoutes);

  app.use("/api", async (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const identity = await databaseIdentity();
    if (req.get("X-BRLIFT-Contract") !== String(identity.contractVersion)) {
      res.status(428).json({
        error:
          "Aplicativo desatualizado. Atualize web/mobile e backend juntos; não apague seus dados locais.",
        code: "CLIENT_OUTDATED",
      });
      return;
    }
    if (req.get("X-BRLIFT-Database") !== identity.databaseId) {
      res.status(428).json({
        error:
          "Banco reinicializado ou aplicativo desatualizado. Entre novamente e reinicialize o espaço local antes de enviar dados.",
        code: "DATABASE_CHANGED",
      });
      return;
    }
    next();
  });

  app.use("/api", createUsersRoutes());
  app.use("/api", createCatalogRoutes());
  app.use("/api", createMediaRoutes());
  app.use("/api", createDocumentsRoutes());
  app.use("/api", createRecordsRoutes());

  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError) {
        res.status(422).json({
          error: error.issues
            .map((issue) => issue.path.join(".") + ": " + issue.message)
            .join("; "),
        });
        return;
      }
      if (error.code === "23505") {
        res.status(409).json({
          error:
            "Número, documento ou código já cadastrado. Use outro valor ou edite o cadastro existente.",
        });
        return;
      }
      if (error.code === "23503") {
        res.status(422).json({ error: "Referência a cadastro inexistente." });
        return;
      }
      if (
        ["23514", "22003", "22007", "22008", "22P02", "23502"].includes(
          error.code,
        )
      ) {
        res.status(422).json({
          error:
            "Dados inválidos: confira os campos numéricos, datas e vínculos obrigatórios.",
        });
        return;
      }
      if (!error.status) console.error(error);
      res.status(error.status || 500).json({
        error: error.status
          ? error.message
          : "Não foi possível concluir a operação.",
      });
    },
  );
  return app;
}
