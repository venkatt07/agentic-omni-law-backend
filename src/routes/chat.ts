import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { chatService } from "../services/chat.service.js";

const schema = z.object({
  case_id: z.string().optional(),
  message: z.string().min(1),
  language: z.string().optional(),
  mode: z.enum(["support_fast", "default"]).optional(),
  recent_messages: z.array(z.object({ role: z.string(), text: z.string() })).max(12).optional(),
});

export const chatRouter = Router();

chatRouter.post("/", requireAuth, validateBody(schema), async (req, res, next) => {
  try {
    res.json(await chatService.reply(req.auth!.userId, req.body));
  } catch (e) {
    next(e);
  }
});

chatRouter.post("/stream", requireAuth, validateBody(schema), async (req, res, next) => {
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    await chatService.streamReply(req.auth!.userId, req.body, {
      onTyping: async () => {
        res.write(`data: ${JSON.stringify({ event: "typing" })}\n\n`);
      },
      onToken: async (chunk) => {
        res.write(`data: ${JSON.stringify({ event: "chunk", chunk })}\n\n`);
      },
      onDone: async (meta) => {
        res.write(`data: ${JSON.stringify({ event: "done", done: true, ...meta })}\n\n`);
      },
    });
    res.end();
  } catch (e) {
    try {
      res.write(`data: ${JSON.stringify({ event: "error", message: "I could not complete that right now. Please try again." })}\n\n`);
      res.end();
    } catch {
      // ignore
    }
    console.error("chat_stream_failed", e);
    return;
  }
});
