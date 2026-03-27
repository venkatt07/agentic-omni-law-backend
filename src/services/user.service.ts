import { prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";
export const userService = { async getPreferences(userId: string) { const u = await prisma.user.findUnique({ where: { id: userId } }); if (!u) throw new HttpError(404, "User not found", "user_not_found"); return { language: u.preferredLanguage }; }, async updatePreferences(userId: string, input: { language: string }) { const u = await prisma.user.update({ where: { id: userId }, data: { preferredLanguage: input.language } }); return { language: u.preferredLanguage }; } };
