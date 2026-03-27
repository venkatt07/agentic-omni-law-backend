import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { userService } from "../services/user.service.js";
import { authService } from "../services/auth.service.js";

const prefSchema = z.object({ language: z.enum(["English", "Hindi", "Tamil", "Bengali"]) });
const activeCaseSchema = z.object({ case_id: z.string().min(1) });

export const usersRouter = Router();
usersRouter.get("/me", requireAuth, async (req, res, next) => { try { res.json(await authService.me(req.auth!.userId)); } catch (e) { next(e); } });
usersRouter.patch("/me/active-case", requireAuth, validateBody(activeCaseSchema), async (req, res, next) => {
  try {
    res.json(await authService.setActiveCase(req.auth!.userId, req.body.case_id));
  } catch (e) {
    next(e);
  }
});
usersRouter.get("/me/preferences", requireAuth, async (req, res, next) => { try { res.json(await userService.getPreferences(req.auth!.userId)); } catch (e) { next(e); } });
usersRouter.patch("/me/preferences", requireAuth, validateBody(prefSchema), async (req, res, next) => { try { res.json(await userService.updatePreferences(req.auth!.userId, req.body)); } catch (e) { next(e); } });
