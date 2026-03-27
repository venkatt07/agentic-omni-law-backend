import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import { getEnv } from "./config/env.js";
import { requestId } from "./middleware/requestId.js";
import { authRateLimit, chatRateLimit } from "./middleware/rateLimit.js";
import { errorMiddleware } from "./middleware/error.js";
import { healthRouter, metricsRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { casesRouter } from "./routes/cases.js";
import { runsRouter } from "./routes/runs.js";
import { chatRouter } from "./routes/chat.js";
import { notificationsRouter } from "./routes/notifications.js";
import { adminRouter } from "./routes/admin.js";
import { legalCorpusService } from "./services/legalCorpus.service.js";
import { runtimeMetrics } from "./ai/runtimeMetrics.js";
import { analyticsRouter } from "./routes/analytics.js";
import { analyticsService } from "./services/analytics.service.js";

export function createApp() {
  const env = getEnv();
  const app = express();

  fs.mkdirSync(path.resolve(process.cwd(), env.STORAGE_DIR), { recursive: true });
  void legalCorpusService.preload();
  void analyticsService.ensureSchema();

  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestId);
  app.use("/api", (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      runtimeMetrics.recordApiLatency(req.path, Date.now() - started);
    });
    next();
  });

  app.use("/api/auth", authRateLimit);
  app.use("/api/chat", chatRateLimit);

  app.use("/api/health", healthRouter);
  app.use("/api/metrics", metricsRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/cases", casesRouter);
  app.use("/api/runs", runsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/analytics", analyticsRouter);

  app.use(errorMiddleware);
  return app;
}
