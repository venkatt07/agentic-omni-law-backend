import { Router } from "express";
import { getEnv } from "../config/env.js";
import { runtimeMetrics } from "../ai/runtimeMetrics.js";

export const healthRouter = Router();
healthRouter.get("/", (_req, res) => {
  const env = getEnv();
  res.json({ ok: true, service: "agentic-omni-law-backend", env: env.NODE_ENV, db: "mysql", smtpConfigured: env.smtpConfigured, time: new Date().toISOString() });
});

export const metricsRouter = Router();
metricsRouter.get("/", (_req, res) => {
  res.json(runtimeMetrics.snapshot());
});
