import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { authService } from "../services/auth.service.js";

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(6).optional().or(z.literal("")),
  gender: z.string().optional().or(z.literal("")),
  dateOfBirth: z.string().optional().or(z.literal("")),
  password: z.string().min(8),
  role: z.enum(["Lawyer", "Law Student", "Business/Corporate", "Individual", "Normal Person"]),
});
const verifySchema = z.object({ emailOrPhone: z.string().min(3), code: z.string().length(6) });
const resendSchema = z.object({ emailOrPhone: z.string().min(3) });
const loginSchema = z.object({ emailOrPhone: z.string().min(3), password: z.string().min(1) });
const forgotPasswordSchema = z.object({ email: z.string().email() });
const resetPasswordSchema = z.object({ email: z.string().email(), code: z.string().length(6), newPassword: z.string().min(8) });
const activeCaseSchema = z.object({ case_id: z.string().min(1) });

export const authRouter = Router();
authRouter.post("/signup", validateBody(signupSchema), async (req, res, next) => { try { res.status(201).json(await authService.signup(req.body)); } catch (e) { next(e); } });
authRouter.post("/resend", validateBody(resendSchema), async (req, res, next) => { try { res.json(await authService.resend(req.body)); } catch (e) { next(e); } });
authRouter.post("/verify", validateBody(verifySchema), async (req, res, next) => { try { res.json(await authService.verify(req.body)); } catch (e) { next(e); } });
authRouter.post("/login", validateBody(loginSchema), async (req, res, next) => { try { res.json(await authService.login(req.body)); } catch (e) { next(e); } });
authRouter.post("/password/forgot", validateBody(forgotPasswordSchema), async (req, res, next) => {
  try { res.json(await authService.requestPasswordReset(req.body)); } catch (e) { next(e); }
});
authRouter.post("/password/reset", validateBody(resetPasswordSchema), async (req, res, next) => {
  try { res.json(await authService.resetPassword(req.body)); } catch (e) { next(e); }
});
authRouter.get("/me", requireAuth, async (req, res, next) => { try { res.json(await authService.me(req.auth!.userId)); } catch (e) { next(e); } });
authRouter.patch("/me/active-case", requireAuth, validateBody(activeCaseSchema), async (req, res, next) => {
  try { res.json(await authService.setActiveCase(req.auth!.userId, req.body.case_id)); } catch (e) { next(e); }
});
