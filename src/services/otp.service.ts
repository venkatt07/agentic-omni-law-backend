import bcrypt from "bcrypt";
import { prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";
const EXP_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const HOURLY_LIMIT = 5;
const MAX_ATTEMPTS = 5;
const gen = () => String(Math.floor(100000 + Math.random() * 900000));
export const otpService = {
  async create(userId: string) { const code = gen(); const codeHash = await bcrypt.hash(code, 10); await prisma.otp.create({ data: { userId, codeHash, expiresAt: new Date(Date.now() + EXP_MS), attempts: 0, lastSentAt: new Date() } }); return code; },
  async ensureResendAllowed(userId: string) { const latest = await prisma.otp.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }); if (latest && Date.now() - latest.lastSentAt.getTime() < RESEND_MS) throw new HttpError(429, "Please wait 60 seconds before requesting another OTP.", "otp_resend_cooldown"); const c = await prisma.otp.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 3600000) } } }); if (c >= HOURLY_LIMIT) throw new HttpError(429, "OTP resend limit reached. Try again later.", "otp_resend_limit"); },
  async verify(userId: string, code: string) { const latest = await prisma.otp.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }); if (!latest) throw new HttpError(400, "No OTP found. Please request a new code.", "otp_missing"); if (latest.expiresAt.getTime() < Date.now()) throw new HttpError(400, "OTP expired. Please request a new code.", "otp_expired"); if (latest.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "Maximum OTP attempts reached. Please request a new code.", "otp_attempts_exceeded"); const ok = await bcrypt.compare(code, latest.codeHash); if (!ok) { await prisma.otp.update({ where: { id: latest.id }, data: { attempts: { increment: 1 } } }); throw new HttpError(400, "Invalid verification code.", "otp_invalid"); } return latest; },
};
