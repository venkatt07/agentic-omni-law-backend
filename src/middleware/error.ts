import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export function errorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err as Error);
  if (err instanceof ZodError) {
    return res.status(400).json({ message: "Validation failed", code: "validation_error", issues: err.issues, request_id: req.requestId });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, code: err.code, details: err.details, request_id: req.requestId });
  }
  const e = err as any;
  return res.status(e?.status || e?.statusCode || 500).json({ message: e?.message || "Internal Server Error", request_id: req.requestId });
}
