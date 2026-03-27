import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { notificationService } from "../services/notification.service.js";
import { validateParams } from "../middleware/validate.js";

const paramsSchema = z.object({ id: z.string().min(1) });

export const notificationsRouter = Router();
const asParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || "";

notificationsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    res.json(await notificationService.list(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

notificationsRouter.get("/unread-count", requireAuth, async (req, res, next) => {
  try {
    res.json(await notificationService.unreadCount(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

notificationsRouter.patch("/read-all", requireAuth, async (req, res, next) => {
  try {
    res.json(await notificationService.markAllRead(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

notificationsRouter.patch("/:id/read", requireAuth, validateParams(paramsSchema), async (req, res, next) => {
  try {
    res.json(await notificationService.markRead(req.auth!.userId, asParam(req.params.id)));
  } catch (e) {
    next(e);
  }
});
