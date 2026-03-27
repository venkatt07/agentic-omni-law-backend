import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { HttpError } from "../middleware/error.js";
import { legalCorpusIndexService } from "../services/legalCorpusIndex.service.js";

const reindexSchema = z.object({ force: z.boolean().optional(), max_files: z.number().int().positive().optional() }).optional();

function requireAdminRole(role?: string) {
  return role === "LAWYER";
}

export const adminRouter = Router();

adminRouter.get("/legal-corpus/status", requireAuth, async (req, res, next) => {
  try {
    if (!requireAdminRole(req.auth?.role)) throw new HttpError(403, "Forbidden", "forbidden");
    res.json(await legalCorpusIndexService.getStatus());
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/legal-corpus/reindex", requireAuth, validateBody(reindexSchema as any), async (req, res, next) => {
  try {
    if (!requireAdminRole(req.auth?.role)) throw new HttpError(403, "Forbidden", "forbidden");
    const promise = legalCorpusIndexService.reindex({
      force: !!req.body?.force,
      maxFiles: req.body?.max_files ? Number(req.body.max_files) : undefined,
    });
    res.status(202).json({ accepted: true, started: true });
    void promise.catch(() => undefined);
  } catch (e) {
    next(e);
  }
});
