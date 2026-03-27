import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { analyticsService } from "../services/analytics.service.js";
import { validateBody } from "../middleware/validate.js";
import { getEnv } from "../config/env.js";

const trackSchema = z.object({
  event_name: z.string().min(1).max(64).optional(),
  path: z.string().min(1).max(191),
  title: z.string().max(191).optional(),
  visitor_id: z.string().min(8).max(191),
  session_id: z.string().min(8).max(191),
  referrer: z.string().max(512).optional().nullable(),
  locale: z.string().max(64).optional().nullable(),
  timezone: z.string().max(96).optional().nullable(),
  viewport_width: z.number().int().nonnegative().optional().nullable(),
  viewport_height: z.number().int().nonnegative().optional().nullable(),
  screen_width: z.number().int().nonnegative().optional().nullable(),
  screen_height: z.number().int().nonnegative().optional().nullable(),
  country_code: z.string().max(8).optional().nullable(),
  country_name: z.string().max(128).optional().nullable(),
  region_name: z.string().max(128).optional().nullable(),
  city_name: z.string().max(128).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});

export const analyticsRouter = Router();

analyticsRouter.post("/track", validateBody(trackSchema), async (req, res, next) => {
  try {
    let userId: string | null = null;
    const authHeader = req.header("authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7).trim(), getEnv().JWT_SECRET) as any;
        userId = String(payload?.sub || "") || null;
      } catch {
        userId = null;
      }
    }
    const forwarded = req.headers["x-forwarded-for"];
    const ip = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || req.socket.remoteAddress || "");
    res.status(202).json(await analyticsService.trackPageEvent(req.body, {
      userId,
      requestId: req.requestId || null,
      userAgent: req.header("user-agent") || null,
      ip,
    }));
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/overview", async (_req, res, next) => {
  try {
    res.json(await analyticsService.getOverview());
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/dashboard", async (req, res, next) => {
  try {
    let userId: string | null = null;
    const authHeader = req.header("authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7).trim(), getEnv().JWT_SECRET) as any;
        userId = String(payload?.sub || "") || null;
      } catch {
        userId = null;
      }
    }
    res.json(await analyticsService.getDashboardAnalytics(userId));
  } catch (e) {
    next(e);
  }
});
