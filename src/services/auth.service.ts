import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { type User } from "../db/types.js";
import { prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";
import { emailService } from "./email.service.js";
import { otpService } from "./otp.service.js";
import { FRONTEND_TO_ROLE, ROLE_TO_FRONTEND } from "../utils/roleMap.js";
import { getEnv } from "../config/env.js";

const normEmail = (v: string) => v.trim().toLowerCase();
const normPhone = (v?: string) => (v ? v.replace(/\s+/g, "").trim() : null);
const publicUser = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  gender: u.gender ?? null,
  dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null,
  role: ROLE_TO_FRONTEND[u.role],
  preferredLanguage: u.preferredLanguage,
  active_case_id: (u as any).activeCaseId ?? null,
});
const findByEmailOrPhone = (value: string) => prisma.user.findFirst({ where: { OR: [{ email: value.trim().toLowerCase() }, { phone: value.trim() }] } });

export const authService = {
  async signup(input: { name: string; email: string; phone?: string; password: string; role: string; gender?: string; dateOfBirth?: string }) {
    const role = FRONTEND_TO_ROLE[input.role]; if (!role) throw new HttpError(400, "Invalid role", "invalid_role");
    const email = normEmail(input.email); const phone = normPhone(input.phone);
    const gender = input.gender ? String(input.gender).trim() : null;
    let dateOfBirth: Date | null = null;
    if (input.dateOfBirth) {
      const parsed = new Date(String(input.dateOfBirth));
      if (Number.isNaN(parsed.getTime())) throw new HttpError(400, "Invalid date of birth", "invalid_dob");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (parsed > today) throw new HttpError(400, "Date of birth cannot be in the future", "invalid_dob");
      dateOfBirth = parsed;
    }
    const existing = await prisma.user.findFirst({ where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] } });
    if (existing) throw new HttpError(409, "A user with this email or phone already exists.", "user_exists");
    emailService.ensureConfiguredForAuth();
    const user = await prisma.user.create({
      data: {
        name: input.name.trim(),
        email,
        phone,
        gender,
        dateOfBirth,
        passwordHash: await bcrypt.hash(input.password, 12),
        role,
        isVerified: false,
      },
    });
    const code = await otpService.create(user.id);
    await emailService.sendOtp(user.email, user.name, code);
    return { ok: true };
  },
  async resend(input: { emailOrPhone: string }) { emailService.ensureConfiguredForAuth(); const user = await findByEmailOrPhone(input.emailOrPhone); if (!user) throw new HttpError(404, "User not found.", "user_not_found"); if (user.isVerified) throw new HttpError(400, "User is already verified.", "already_verified"); await otpService.ensureResendAllowed(user.id); const code = await otpService.create(user.id); await emailService.sendOtp(user.email, user.name, code); return { ok: true }; },
  async verify(input: { emailOrPhone: string; code: string }) { const user = await findByEmailOrPhone(input.emailOrPhone); if (!user) throw new HttpError(404, "User not found.", "user_not_found"); if (!user.isVerified) { await otpService.verify(user.id, input.code.trim()); await prisma.user.update({ where: { id: user.id }, data: { isVerified: true } }); } return { ok: true }; },
  async login(input: { emailOrPhone: string; password: string }) { const user = await findByEmailOrPhone(input.emailOrPhone); if (!user) throw new HttpError(401, "Invalid credentials.", "invalid_credentials"); if (!user.isVerified) throw new HttpError(403, "Please verify your account before login.", "account_unverified"); const ok = await bcrypt.compare(input.password, user.passwordHash); if (!ok) throw new HttpError(401, "Invalid credentials.", "invalid_credentials"); const env = getEnv(); const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any }); return { token, user: publicUser(user) }; },
  async requestPasswordReset(input: { email: string }) {
    const email = normEmail(input.email);
    const user = await findByEmailOrPhone(email);
    if (!user) throw new HttpError(404, "User not found.", "user_not_found");
    emailService.ensureConfiguredForAuth();
    await otpService.ensureResendAllowed(user.id);
    const code = await otpService.create(user.id);
    await emailService.sendOtp(user.email, user.name, code);
    return { ok: true };
  },
  async resetPassword(input: { email: string; code: string; newPassword: string }) {
    const email = normEmail(input.email);
    const user = await findByEmailOrPhone(email);
    if (!user) throw new HttpError(404, "User not found.", "user_not_found");
    await otpService.verify(user.id, input.code.trim());
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { ok: true };
  },
  async me(userId: string) { const u = await prisma.user.findUnique({ where: { id: userId } }); if (!u) throw new HttpError(404, "User not found.", "user_not_found"); return { user: publicUser(u) }; },
  async setActiveCase(userId: string, caseId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    await prisma.user.update({ where: { id: userId }, data: { activeCaseId: caseId } });
    await prisma.case.update({ where: { id: caseId }, data: { status: "active", updatedAt: new Date() } }).catch(() => undefined);
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new HttpError(404, "User not found.", "user_not_found");
    return { user: publicUser(u) };
  },
};
