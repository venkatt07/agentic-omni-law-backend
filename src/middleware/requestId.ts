import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: { userId: string; role: string };
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}
