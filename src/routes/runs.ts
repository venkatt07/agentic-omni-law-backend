import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { prisma } from "../prisma/client.js";
import { translatorService } from "../services/translator.service.js";
import { runCancellationService } from "../services/runCancellation.service.js";
import { RunStatus } from "../db/types.js";

const paramsSchema = z.object({ run_id: z.string().min(1) });

export const runsRouter = Router();
const asParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || "";

runsRouter.get("/:run_id/status", requireAuth, validateParams(paramsSchema), async (req, res, next) => {
  try {
    const status = await orchestratorService.getRunStatus(req.auth!.userId, asParam(req.params.run_id));
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    const language = user?.preferredLanguage || "English";
    res.json({
      ...status,
      steps: (status.steps || []).map((s: any) => ({
        ...s,
        name: translatorService.translateStepName(s.name, language),
        message: s.message ? translatorService.translateText(s.message, language) : s.message,
      })),
    });
  } catch (e) {
    next(e);
  }
});

runsRouter.post("/:run_id/cancel", requireAuth, validateParams(paramsSchema), async (req, res, next) => {
  try {
    const runId = asParam(req.params.run_id);
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { case: true },
    });
    if (!run || run.case.userId !== req.auth!.userId) {
      return res.status(404).json({ message: "Run not found" });
    }
    runCancellationService.cancel(runId);
    const raw = run.stepsJson as any;
    const nextSteps =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? {
            ...raw,
            done: true,
            stage: "Cancelled",
            error: "Run cancelled by user",
            meta: { ...(raw.meta || {}), cancelled: true },
          }
        : raw;
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: RunStatus.FAILED,
        finishedAt: new Date(),
        stepsJson: nextSteps as any,
      },
    }).catch(() => undefined);
    res.json({ ok: true, run_id: runId, status: "cancelled" });
  } catch (e) {
    next(e);
  }
});

runsRouter.post("/:run_id/stop", requireAuth, validateParams(paramsSchema), async (req, res, next) => {
  try {
    const runId = asParam(req.params.run_id);
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { case: true },
    });
    if (!run || run.case.userId !== req.auth!.userId) {
      return res.status(404).json({ message: "Run not found" });
    }
    // Best-effort abort without mutating run status.
    runCancellationService.cancel(runId);
    res.json({ ok: true, run_id: runId, status: "stop_requested" });
  } catch (e) {
    next(e);
  }
});
