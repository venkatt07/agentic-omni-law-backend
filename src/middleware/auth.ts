import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getEnv } from "../config/env.js";
import { HttpError } from "./error.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  if (!h.startsWith("Bearer ")) return next(new HttpError(401, "Missing bearer token", "auth_missing_token"));
  const token = h.slice(7).trim();
  try {
    const payload = jwt.verify(token, getEnv().JWT_SECRET) as any;
    req.auth = { userId: payload.sub, role: payload.role };
    return next();
  } catch {
    return next(new HttpError(401, "Invalid or expired token", "auth_invalid_token"));
  }
}
