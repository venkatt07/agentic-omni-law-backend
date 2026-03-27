import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

export const validateBody = <T extends ZodTypeAny>(schema: T) => (req: Request, _res: Response, next: NextFunction) => {
  try { req.body = schema.parse(req.body); next(); } catch (e) { next(e); }
};
export const validateParams = <T extends ZodTypeAny>(schema: T) => (req: Request, _res: Response, next: NextFunction) => {
  try { req.params = schema.parse(req.params); next(); } catch (e) { next(e); }
};
export const validateQuery = <T extends ZodTypeAny>(schema: T) => (req: Request, _res: Response, next: NextFunction) => {
  try { req.query = schema.parse(req.query); next(); } catch (e) { next(e); }
};
