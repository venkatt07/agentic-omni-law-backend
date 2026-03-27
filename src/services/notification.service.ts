import { mysqlPool, prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";

export const notificationService = {
  async create(userId: string, title: string, body: string) {
    return prisma.notification.create({ data: { userId, title, body } });
  },

  async list(userId: string) {
    const rows = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((n: any) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      read_at: n.readAt?.toISOString() ?? null,
      created_at: n.createdAt.toISOString(),
    }));
  },

  async unreadCount(userId: string) {
    const [rows]: any = await mysqlPool.query(
      "SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL",
      [userId],
    );
    return { unread_count: Number(rows?.[0]?.cnt || 0) };
  },

  async markAllRead(userId: string) {
    await mysqlPool.query(
      "UPDATE notifications SET read_at = NOW(3), updated_at = NOW(3) WHERE user_id = ? AND read_at IS NULL",
      [userId],
    );
    return { ok: true };
  },

  async markRead(userId: string, id: string) {
    const row = await prisma.notification.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new HttpError(404, "Notification not found", "notification_not_found");
    }
    const updated = await prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return {
      id: updated.id,
      read_at: updated.readAt?.toISOString() ?? null,
    };
  },
};
