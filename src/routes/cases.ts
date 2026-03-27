import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { documentService } from "../services/document.service.js";
import { caseService } from "../services/case.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { contractRiskAgentService } from "../services/contractRiskAgent.service.js";
import { caseOutcomeAgentService } from "../services/caseOutcomeAgent.service.js";
import { policyComplianceAgentService } from "../services/policyComplianceAgent.service.js";
import { legalDraftsAgentService } from "../services/legalDraftsAgent.service.js";
import { roleAgentRunService } from "../services/roleAgentRun.service.js";

const caseParams = z.object({ case_id: z.string().min(1) });
const caseDocParams = z.object({ case_id: z.string().min(1), doc_id: z.string().min(1) });
const createCaseSchema = z.object({ title: z.string().min(1).optional() }).optional();
const textSchema = z.object({ text: z.string().min(1), title: z.string().optional() });
const previewSchema = z.object({
  text: z.string().default(""),
  filtersApplied: z
    .object({
      jurisdiction: z.string().optional(),
      legal_domain: z.string().optional(),
      date_range: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
      source_types: z.array(z.string()).optional(),
    })
    .optional(),
});
const contractRiskRunSchema = z.object({ force: z.boolean().optional() }).optional();
const caseOutcomeRunSchema = z.object({ force: z.boolean().optional(), user_overrides: z.record(z.any()).optional() }).optional();
const policyComplianceRunSchema = z.object({ force: z.boolean().optional(), framework: z.string().nullable().optional() }).optional();
const legalDraftGenerateSchema = z.object({
  template_key: z.string().min(1),
  language: z.string().optional(),
  jurisdiction: z.string().optional(),
  party_overrides: z.record(z.any()).optional(),
  extra_instructions: z.string().optional(),
  auto_select: z.boolean().optional(),
});
const draftParamsSchema = z.object({ case_id: z.string().min(1), draft_id: z.string().min(1) });
const draftSaveSchema = z.object({ content: z.string().optional() }).optional();
const runAllBackgroundSchema = z
  .object({
    force: z.boolean().optional(),
    text: z.string().optional(),
    filtersApplied: z.any().optional(),
    doc_names: z.array(z.string().min(1)).optional(),
  })
  .optional();
const queryParsingRunSchema = z
  .object({
    text: z.string().optional(),
    filtersApplied: z.any().optional(),
    doc_names: z.array(z.string().min(1)).optional(),
  })
  .optional();
const roleAgentParamsSchema = z.object({ case_id: z.string().min(1), agent_key: z.string().min(1) });
const roleAgentRunSchema = z
  .object({
    force: z.boolean().optional(),
    output_lang: z.string().optional(),
    profile: z.string().optional(),
  })
  .optional();

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      const userId = req.auth?.userId;
      const caseId = asParam(req.params.case_id);
      if (!userId || !caseId) return cb(new Error("Missing auth/case"), "");
      await documentService.ensureOwnedCase(userId, caseId);
      const dir = documentService.userCaseStorageDir(userId, caseId);
      await fs.promises.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (error) {
      cb(error as Error, "");
    }
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".pdf", ".docx", ".txt"].includes(ext)) return cb(null, true);
    cb(new Error("Only PDF, DOCX and TXT files are supported"));
  },
});

export const casesRouter = Router();
const asParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || "";

casesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    res.json(await caseService.listCases(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/stats/query-parsing", requireAuth, async (req, res, next) => {
  try {
    res.json(await caseService.getQueryParsingStats(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/stats/dashboard", requireAuth, async (req, res, next) => {
  try {
    res.json(await caseService.getDashboardStats(req.auth!.userId));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/", requireAuth, validateBody(createCaseSchema as any), async (req, res, next) => {
  try {
    res.status(201).json(await caseService.createCase(req.auth!.userId, req.body?.title));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await caseService.getCaseById(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/documents/primary", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await caseService.getPrimaryDocument(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/documents/:doc_id", requireAuth, validateParams(caseDocParams), async (req, res, next) => {
  try {
    res.json(
      await caseService.getDocumentById(
        req.auth!.userId,
        asParam(req.params.case_id),
        asParam((req.params as any).doc_id),
      ),
    );
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/documents/:doc_id/text", requireAuth, validateParams(caseDocParams), async (req, res, next) => {
  try {
    const doc = await caseService.getDocumentById(
      req.auth!.userId,
      asParam(req.params.case_id),
      asParam((req.params as any).doc_id),
    );
    res.json({
      doc_id: doc.doc_id,
      name: doc.name,
      mime_type: doc.mime_type,
      extracted_text: String(doc.extracted_text || ""),
      extracted_text_exists: !!doc.extracted_text_exists,
    });
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/documents/:doc_id/download", requireAuth, validateParams(caseDocParams), async (req, res, next) => {
  try {
    const doc = await caseService.getDocumentById(
      req.auth!.userId,
      asParam(req.params.case_id),
      asParam((req.params as any).doc_id),
    );
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.name || "document")}"`);
    res.sendFile(path.resolve(String(doc.path || "")));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/documents/:doc_id/inline", requireAuth, validateParams(caseDocParams), async (req, res, next) => {
  try {
    const doc = await caseService.getDocumentById(
      req.auth!.userId,
      asParam(req.params.case_id),
      asParam((req.params as any).doc_id),
    );
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.name || "document")}"`);
    res.sendFile(path.resolve(String(doc.path || "")));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/outputs/query_parsing", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await caseService.getQueryParsingOutput(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/upload", requireAuth, validateParams(caseParams), upload.array("files"), async (req, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    res.status(201).json(await documentService.saveUploadedFiles(req.auth!.userId, asParam(req.params.case_id), files));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/text", requireAuth, validateParams(caseParams), validateBody(textSchema), async (req, res, next) => {
  try {
    res.status(201).json(await documentService.savePastedText(req.auth!.userId, asParam(req.params.case_id), req.body.text, req.body.title));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/query-preview", requireAuth, validateParams(caseParams), validateBody(previewSchema), async (req, res, next) => {
  try {
    res.json(await orchestratorService.previewQueryParsing(req.auth!.userId, asParam(req.params.case_id), req.body.text || "", req.body.filtersApplied));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/query-parsing/run", requireAuth, validateParams(caseParams), validateBody(queryParsingRunSchema as any), async (req, res, next) => {
  try {
    res.status(202).json(await orchestratorService.startQueryParsingRun(
      req.auth!.userId,
      asParam(req.params.case_id),
      { text: req.body?.text, filtersApplied: req.body?.filtersApplied, doc_names: req.body?.doc_names },
    ));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/run-all", requireAuth, validateParams(caseParams), validateBody(runAllBackgroundSchema as any), async (req, res, next) => {
  try {
    res.status(202).json(await orchestratorService.startRunAllBackground(
      req.auth!.userId,
      asParam(req.params.case_id),
      { force: !!req.body?.force, text: req.body?.text, filtersApplied: req.body?.filtersApplied, doc_names: req.body?.doc_names },
    ));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/run-all/:run_all_id/status", requireAuth, validateParams(z.object({ case_id: z.string().min(1), run_all_id: z.string().min(1) })), async (req, res, next) => {
  try {
    res.json(await orchestratorService.getRunAllStatus(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).run_all_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/run-all/:run_all_id/cancel", requireAuth, validateParams(z.object({ case_id: z.string().min(1), run_all_id: z.string().min(1) })), async (req, res, next) => {
  try {
    res.json(await orchestratorService.cancelRunAll(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).run_all_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/contract-risk", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const runId = typeof req.query.run_id === "string" ? req.query.run_id : null;
    res.json(await contractRiskAgentService.getOverview(req.auth!.userId, asParam(req.params.case_id), runId));
  } catch (e) {
    next(e);
  }
});

casesRouter.post(
  "/:case_id/agents/contract-risk/run",
  requireAuth,
  validateParams(caseParams),
  validateBody(contractRiskRunSchema as any),
  async (req, res, next) => {
    try {
      res.status(202).json(await contractRiskAgentService.startRun(req.auth!.userId, asParam(req.params.case_id), req.body));
    } catch (e) {
      next(e);
    }
  },
);

casesRouter.get("/:case_id/agents/contract-risk/output", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const runId = typeof req.query.run_id === "string" ? req.query.run_id : null;
    res.json(await contractRiskAgentService.getOutput(req.auth!.userId, asParam(req.params.case_id), runId));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/case-outcome", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await caseOutcomeAgentService.getOverview(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/agents/case-outcome/run", requireAuth, validateParams(caseParams), validateBody(caseOutcomeRunSchema as any), async (req, res, next) => {
  try {
    res.status(202).json(await caseOutcomeAgentService.startRun(req.auth!.userId, asParam(req.params.case_id), req.body));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/case-outcome/output", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await caseOutcomeAgentService.getOutput(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/case-outcome/export.pdf", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const out = await caseOutcomeAgentService.exportPdf(req.auth!.userId, asParam(req.params.case_id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `case-outcome-${asParam(req.params.case_id)}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/contract-risk/export.pdf", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const out = await contractRiskAgentService.exportPdf(req.auth!.userId, asParam(req.params.case_id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `contract-risk-${asParam(req.params.case_id)}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/policy-compliance", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await policyComplianceAgentService.getOverview(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/agents/policy-compliance/run", requireAuth, validateParams(caseParams), validateBody(policyComplianceRunSchema as any), async (req, res, next) => {
  try {
    res.status(202).json(await policyComplianceAgentService.startRun(req.auth!.userId, asParam(req.params.case_id), req.body));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/policy-compliance/output", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await policyComplianceAgentService.getOutput(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/policy-compliance/export.pdf", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const out = await policyComplianceAgentService.exportPdf(req.auth!.userId, asParam(req.params.case_id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `policy-compliance-${asParam(req.params.case_id)}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/legal-drafts", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    res.json(await legalDraftsAgentService.getOverview(req.auth!.userId, asParam(req.params.case_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/agents/legal-drafts/generate", requireAuth, validateParams(caseParams), validateBody(legalDraftGenerateSchema as any), async (req, res, next) => {
  try {
    res.status(202).json(await legalDraftsAgentService.generateDraft(req.auth!.userId, asParam(req.params.case_id), req.body));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/legal-drafts/:draft_id", requireAuth, validateParams(draftParamsSchema as any), async (req, res, next) => {
  try {
    res.json(await legalDraftsAgentService.getDraft(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).draft_id)));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/agents/legal-drafts/:draft_id/save", requireAuth, validateParams(draftParamsSchema as any), validateBody(draftSaveSchema as any), async (req, res, next) => {
  try {
    res.json(await legalDraftsAgentService.saveDraft(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).draft_id), req.body));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/legal-drafts/:draft_id/export.pdf", requireAuth, validateParams(draftParamsSchema as any), async (req, res, next) => {
  try {
    const out = await legalDraftsAgentService.exportPdf(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).draft_id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `legal-draft-${asParam((req.params as any).draft_id)}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/legal-drafts/:draft_id/export.docx", requireAuth, validateParams(draftParamsSchema as any), async (req, res, next) => {
  try {
    const out = await legalDraftsAgentService.exportDocx(req.auth!.userId, asParam(req.params.case_id), asParam((req.params as any).draft_id));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `legal-draft-${asParam((req.params as any).draft_id)}.docx`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/query-parsing/export.pdf", requireAuth, validateParams(caseParams), async (req, res, next) => {
  try {
    const out = await caseService.renderQueryParsingExportPdf(req.auth!.userId, asParam(req.params.case_id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `query-parsing-${asParam(req.params.case_id)}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/:agent_key", requireAuth, validateParams(roleAgentParamsSchema as any), async (req, res, next) => {
  try {
    const caseId = asParam(req.params.case_id);
    const agentKey = asParam((req.params as any).agent_key);
    if (!roleAgentRunService.isRoleAgentKey(agentKey)) return next();
    const outputLang = typeof req.query.output_lang === "string" ? req.query.output_lang : "English";
    const profile = typeof req.query.profile === "string" ? req.query.profile : "standard";
    res.json(await roleAgentRunService.getMeta(req.auth!.userId, caseId, agentKey, outputLang, profile));
  } catch (e) {
    next(e);
  }
});

casesRouter.post("/:case_id/agents/:agent_key/run", requireAuth, validateParams(roleAgentParamsSchema as any), validateBody(roleAgentRunSchema as any), async (req, res, next) => {
  try {
    const caseId = asParam(req.params.case_id);
    const agentKey = asParam((req.params as any).agent_key);
    if (!roleAgentRunService.isRoleAgentKey(agentKey)) return next();
    res.status(202).json(await roleAgentRunService.startRun(req.auth!.userId, caseId, agentKey, req.body));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/:agent_key/output", requireAuth, validateParams(roleAgentParamsSchema as any), async (req, res, next) => {
  try {
    const caseId = asParam(req.params.case_id);
    const agentKey = asParam((req.params as any).agent_key);
    if (!roleAgentRunService.isRoleAgentKey(agentKey)) return next();
    const outputLang = typeof req.query.output_lang === "string" ? req.query.output_lang : "English";
    const profile = typeof req.query.profile === "string" ? req.query.profile : "standard";
    res.json(await roleAgentRunService.getOutput(req.auth!.userId, caseId, agentKey, outputLang, profile));
  } catch (e) {
    next(e);
  }
});

casesRouter.get("/:case_id/agents/:agent_key/export.pdf", requireAuth, validateParams(roleAgentParamsSchema as any), async (req, res, next) => {
  try {
    const caseId = asParam(req.params.case_id);
    const agentKey = asParam((req.params as any).agent_key);
    if (!roleAgentRunService.isRoleAgentKey(agentKey)) return next();
    const out = await roleAgentRunService.exportPdf(req.auth!.userId, caseId, agentKey);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(out.filename || `${agentKey}-${caseId}.pdf`)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(out.buffer);
  } catch (e) {
    next(e);
  }
});
