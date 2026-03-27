import nodemailer from "nodemailer";
import { getEnv } from "../config/env.js";
import { HttpError } from "../middleware/error.js";

class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;
  private init() {
    if (this.initialized) return;
    this.initialized = true;
    const env = getEnv();
    if (!env.smtpConfigured) return;
    this.transporter = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  }
  ensureConfiguredForAuth() {
    this.init();
    if (!this.transporter) throw new HttpError(503, "SMTP not configured. Configure Gmail SMTP (smtp.gmail.com:587 + App Password).", "smtp_not_configured");
  }
  async sendOtp(to: string, name: string, code: string) {
    this.ensureConfiguredForAuth();
    const env = getEnv();
    if (env.NODE_ENV !== "production") {
      // Dev-only visibility for terminal verification when inbox access is unavailable.
      console.log(`[DEV_OTP] email=${to} code=${code}`);
    }
    await this.transporter!.sendMail({
      from: env.SMTP_FROM,
      to,
      subject: "AGENTIC OMNI LAW OTP Verification",
      text: `Hello ${name}, your verification code is ${code}. It expires in 10 minutes.`,
      html: `<div><h2>AGENTIC OMNI LAW</h2><p>Hello ${name},</p><p>Your OTP is:</p><p style=\"font-size:24px;font-weight:bold;letter-spacing:4px\">${code}</p><p>Expires in 10 minutes.</p></div>`,
    });
  }
}
export const emailService = new EmailService();
