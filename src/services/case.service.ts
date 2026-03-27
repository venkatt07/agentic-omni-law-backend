import { mysqlPool, prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";
import { translatorService } from "./translator.service.js";
import { ALL_ROLE_AGENT_KEYS, ROLE_TO_FRONTEND } from "../utils/roleMap.js";
import type { CaseSummaryDto, RunStep } from "../types/api.js";
import { detectLanguageInfo } from "../utils/language.js";
import { resolveCaseDocumentMeta, resolvePrimaryCaseDocumentMeta } from "./documentMeta.service.js";
import { createPdfBuffer, shortenText, toDateTime, toSingleLine } from "../utils/pdf.js";
import { applyRoleAwareCommonPayload } from "./agents/agentRunner.js";
import { normalizeRoleAgentPayloadForDisplay } from "./roleAgentRun.service.js";

const ROLE_AWARE_COMMON_KEYS = new Set([
  "query_parsing",
  "terms_and_policies",
  "contract_risk",
  "outcome_projection",
  "policy_compliance",
  "legal_drafts_validation",
  "final_summary",
]);

function parseSteps(run: { stepsJson: unknown } | null): RunStep[] {
  if (!run || !run.stepsJson) return [];
  if (Array.isArray(run.stepsJson)) return run.stepsJson as RunStep[];
  if (typeof run.stepsJson === "object" && run.stepsJson && "steps" in (run.stepsJson as any)) {
    return ((run.stepsJson as any).steps ?? []) as RunStep[];
  }
  return [];
}

function deriveAgentStatus(outputs: { agentKey: string; updatedAt: Date }[], latestRun: { stepsJson: unknown } | null) {
  const status: Record<string, { state: string; updated_at: string }> = {};
  const steps = parseSteps(latestRun);
  for (const step of steps) {
    status[step.name] = { state: step.state, updated_at: new Date().toISOString() };
  }
  for (const o of outputs) {
    if (!status[o.agentKey]) {
      status[o.agentKey] = { state: "SUCCEEDED", updated_at: o.updatedAt.toISOString() };
    }
  }
  return status;
}

function escHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRoleDisplaySnippets(primaryDoc: any) {
  const docId = String(primaryDoc?.id || primaryDoc?.doc_id || "user_doc");
  const text = String(primaryDoc?.extractedText || primaryDoc?.extracted_text || "").trim();
  if (!text) return [];
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 45);
  const selected = (paragraphs.length ? paragraphs : text.match(/.{1,260}(?:\s|$)/g) || [])
    .map((part) => String(part || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  return selected.map((snippet, idx) => ({
    doc_id: docId,
    chunk_id: `case-service:${idx + 1}`,
    snippet,
    source_type: "user_doc",
  }));
}

function qpDisplay(payload: any) {
  const jurisdiction =
    (typeof payload?.jurisdiction === "string" ? payload.jurisdiction : null) ||
    (typeof payload?.jurisdiction?.country === "string" ? payload.jurisdiction.country : null) ||
    payload?.jurisdiction_guess ||
    "Unknown";
  const domain =
    (typeof payload?.legal_domain === "string" ? payload.legal_domain : null) ||
    (typeof payload?.domain === "string" ? payload.domain : null) ||
    (typeof payload?.domain?.primary === "string" ? payload.domain.primary : null) ||
    "General";
  const summary =
    payload?.executive_summary ||
    payload?.executive_summary_text ||
    payload?.summary ||
    "No executive summary available.";
  const legalGrounds = Array.isArray(payload?.legal_grounds)
    ? payload.legal_grounds
    : Array.isArray(payload?.issue_groups)
      ? payload.issue_groups.map((g: any) => g?.title || g?.label).filter(Boolean)
      : [];
  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  const confidencePct =
    typeof payload?.confidence_score === "number"
      ? Math.max(1, Math.min(99, Math.round(payload.confidence_score)))
      : typeof payload?.confidence === "number"
        ? Math.max(1, Math.min(99, Math.round(payload.confidence * 100)))
        : 70;
  const language =
    (typeof payload?.language?.detected === "string" ? payload.language.detected : null) ||
    (typeof payload?.detected_language === "string" ? payload.detected_language : null) ||
    "English";
  return { jurisdiction, domain, summary, legalGrounds, citations, confidencePct, language };
}

function isRejectedQueryParsingPayload(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  const rejectedFlag = payload.rejected_input === true || String(payload.rejected_input || "").toLowerCase() === "true";
  const invalidFlag = payload.analysis_valid === false || String(payload.analysis_valid || "").toLowerCase() === "false";
  const modeRejected = String(payload.output_mode || "").toLowerCase() === "rejected_input";
  const parserPath = String(payload?.qa_debug?.parser_path || "").trim();
  const guardRejected = [
    "deterministic_prompt_template_guard",
    "deterministic_low_signal_query_guard",
    "deterministic_short_input_guard",
    "deterministic_missing_input_guard",
    "deterministic_non_legal_input_guard",
    "deterministic_mixed_case_bundle_guard",
  ].includes(parserPath);
  const summary = String(payload.summary || payload.executive_summary_text || "").toLowerCase();
  const summaryRejected = summary.startsWith("rejected non-case input");
  return rejectedFlag || modeRejected || summaryRejected || guardRejected || (invalidFlag && (summaryRejected || modeRejected || guardRejected));
}

export const caseService = {
  async createCase(userId: string, title?: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, "User not found", "user_not_found");
    const c = await prisma.case.create({
      data: {
        userId,
        role: user.role,
        language: user.preferredLanguage,
        detectedLanguage: "Unknown",
        filtersJson: {},
        title: (title || "Current Case Workspace").trim() || "Current Case Workspace",
        status: "active",
      },
    });
    await prisma.user.update({ where: { id: userId }, data: { activeCaseId: c.id } }).catch(() => undefined);
    return { case_id: c.id };
  },

  async listCases(userId: string): Promise<CaseSummaryDto[]> {
    const rows = await prisma.case.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      include: {
        outputs: {
          where: { agentKey: "query_parsing" },
          orderBy: { updatedAt: "desc" },
          select: { payloadJson: true, updatedAt: true },
        },
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      },
      take: 100,
    });

    const caseIds = rows.map((c: any) => c.id);
    const runCounts = new Map<string, { run_count: number; successful_run_count: number }>();
    if (caseIds.length) {
      try {
        const placeholders = caseIds.map(() => "?").join(",");
        const [countRows]: any = await mysqlPool.query(
          `SELECT case_id, COUNT(*) AS run_count, SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS successful_run_count
           FROM runs
           WHERE case_id IN (${placeholders})
           GROUP BY case_id`,
          caseIds,
        );
        for (const row of countRows || []) {
          runCounts.set(String(row.case_id), {
            run_count: Number(row.run_count || 0),
            successful_run_count: Number(row.successful_run_count || 0),
          });
        }
      } catch {
        for (const c of rows as any[]) {
          try {
            const [singleRows]: any = await mysqlPool.query(
              `SELECT status FROM runs WHERE case_id = ?`,
              [c.id],
            );
            const allRuns = Array.isArray(singleRows) ? singleRows : [];
            runCounts.set(c.id, {
              run_count: allRuns.length,
              successful_run_count: allRuns.filter((r: any) => String(r.status) === "SUCCEEDED").length,
            });
          } catch {
            runCounts.set(c.id, { run_count: 0, successful_run_count: 0 });
          }
        }
      }
    }

    const list = rows.map((c: any) => {
      const qpOutputs = Array.isArray(c.outputs) ? c.outputs : [];
      const latestQpPayload = (qpOutputs[0]?.payloadJson as any) || {};
      const hasAcceptedQueryParsing = qpOutputs.some((o: any) => !isRejectedQueryParsingPayload((o?.payloadJson as any) || {}));
      const hasRejectedQueryParsing = qpOutputs.some((o: any) => isRejectedQueryParsingPayload((o?.payloadJson as any) || {}));
      // Hide a case from "Previous Cases" only when every Query Parsing output is rejected/non-case.
      const queryParsingRejected = hasRejectedQueryParsing && !hasAcceptedQueryParsing;
      const domain =
        ((c as any).domainPrimary && (c as any).domainSubtype ? `${(c as any).domainPrimary} / ${(c as any).domainSubtype}` : null) ||
        ((c as any).domainPrimary ? String((c as any).domainPrimary) : null) ||
        (typeof latestQpPayload?.domain === "string" ? latestQpPayload.domain : null) ||
        (typeof latestQpPayload?.legal_domain === "string" ? latestQpPayload.legal_domain : null) ||
        (typeof latestQpPayload?.domain?.primary === "string" ? latestQpPayload.domain.primary : null) ||
        latestQpPayload?.jurisdiction_guess ||
        "General";
      const counts = runCounts.get(c.id) || { run_count: 0, successful_run_count: 0 };
      return {
        case_id: c.id,
        title: c.title,
        domain_primary: (c as any).domainPrimary || null,
        domain_subtype: (c as any).domainSubtype || null,
        status: String((c as any).status || "active"),
        domain,
        updated_at: c.updatedAt.toISOString(),
        last_run_status: c.runs[0]?.status ?? null,
        run_count: counts.run_count,
        successful_run_count: counts.successful_run_count,
        query_parsing_rejected: queryParsingRejected,
      };
    });
    list.sort((a: any, b: any) => {
      const ta = new Date(String(a.updated_at || 0)).getTime();
      const tb = new Date(String(b.updated_at || 0)).getTime();
      if (tb !== ta) return tb - ta;
      return String(b.case_id || "").localeCompare(String(a.case_id || ""));
    });
    return list as any;
  },

  async getQueryParsingStats(userId: string) {
    let analyzedCases = 0;
    let analyzedUniqueCases = 0;
    let totalRuns = 0;
    let successfulRuns = 0;

    try {
      const [runRows]: any = await mysqlPool.query(
        `SELECT COUNT(*) AS total_runs,
                SUM(CASE WHEN r.status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS successful_runs,
                COUNT(DISTINCT CASE WHEN r.status = 'SUCCEEDED' THEN r.case_id END) AS analyzed_unique_cases
         FROM runs r
         INNER JOIN cases c ON c.id = r.case_id
         WHERE c.user_id = ?
           AND (
             r.steps_json LIKE '%\"agent_key\":\"query_parsing\"%'
             OR r.steps_json LIKE '%\"name\":\"query_parsing\"%'
           )`,
        [userId],
      );
      totalRuns = Number(runRows?.[0]?.total_runs || 0);
      successfulRuns = Number(runRows?.[0]?.successful_runs || 0);
      analyzedUniqueCases = Number(runRows?.[0]?.analyzed_unique_cases || 0);

      // Exclude rejected/non-case Query Parsing outputs from "Cases Analyzed".
      const [acceptedRows]: any = await mysqlPool.query(
        `SELECT COUNT(DISTINCT ao.case_id) AS analyzed_cases
         FROM agent_outputs ao
         INNER JOIN cases c ON c.id = ao.case_id
         WHERE c.user_id = ?
           AND ao.agent_key = 'query_parsing'
           AND COALESCE(LOWER(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.output_mode'))), '') <> 'rejected_input'
           AND COALESCE(LOWER(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.rejected_input'))), 'false') NOT IN ('true', '1')
           AND COALESCE(LOWER(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.analysis_valid'))), 'true') <> 'false'
           AND COALESCE(LOWER(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.summary'))), '') NOT LIKE 'rejected non-case input%'`,
        [userId],
      );
      analyzedCases = Number(acceptedRows?.[0]?.analyzed_cases || 0);
      analyzedUniqueCases = analyzedCases;
    } catch {
      analyzedCases = 0;
      totalRuns = 0;
      successfulRuns = 0;
      analyzedUniqueCases = 0;
    }

    const successRate = totalRuns > 0 ? Math.round((successfulRuns / totalRuns) * 100) : 0;
    return {
      analyzed_cases: analyzedCases,
      analyzed_unique_cases: analyzedUniqueCases,
      total_runs: totalRuns,
      successful_runs: successfulRuns,
      success_rate: successRate,
    };
  },

  async getDashboardStats(userId: string) {
    const safeNumber = async (query: string, params: any[], field: string) => {
      try {
        const [rows]: any = await mysqlPool.query(query, params);
        return Number(rows?.[0]?.[field] || 0);
      } catch {
        return 0;
      }
    };

    const activeContracts = await safeNumber(
      `SELECT COUNT(*) AS val
       FROM cases
       WHERE user_id = ? AND status = 'active'`,
      [userId],
      "val",
    );

    const activeContractsWeeklyDelta = await safeNumber(
      `SELECT COUNT(*) AS val
       FROM cases
       WHERE user_id = ?
         AND status = 'active'
         AND updated_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)`,
      [userId],
      "val",
    );

    const highRiskCases = await safeNumber(
      `SELECT COUNT(DISTINCT c.id) AS val
       FROM cases c
       INNER JOIN agent_outputs ao
         ON ao.case_id = c.id
       WHERE c.user_id = ?
         AND c.status = 'active'
         AND (
           JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.scores.risk_level')) = 'High'
           OR JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.risk_level')) = 'High'
           OR JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.risk_assessment.risk_level')) = 'High'
         )`,
      [userId],
      "val",
    );

    const highRiskPrev = await safeNumber(
      `SELECT COUNT(DISTINCT c.id) AS val
       FROM cases c
       INNER JOIN agent_outputs ao
         ON ao.case_id = c.id
       WHERE c.user_id = ?
         AND c.status = 'active'
         AND ao.updated_at >= (UTC_TIMESTAMP() - INTERVAL 14 DAY)
         AND ao.updated_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY)
         AND (
           JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.scores.risk_level')) = 'High'
           OR JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.risk_level')) = 'High'
           OR JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.risk_assessment.risk_level')) = 'High'
         )`,
      [userId],
      "val",
    );
    const highRiskDelta = highRiskCases - highRiskPrev;

    const complianceScore = await safeNumber(
      `SELECT ROUND(AVG(score_num), 0) AS val
       FROM (
         SELECT
           CASE
             WHEN JSON_EXTRACT(ao.payload_json, '$.overall_score') IS NOT NULL
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.overall_score')) AS DECIMAL(10,2))
             WHEN JSON_EXTRACT(ao.payload_json, '$.compliance_score') IS NOT NULL
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.compliance_score')) AS DECIMAL(10,2))
             ELSE NULL
           END AS score_num
         FROM agent_outputs ao
         INNER JOIN cases c ON c.id = ao.case_id
         WHERE c.user_id = ?
           AND ao.agent_key = 'policy_compliance'
           AND ao.updated_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
       ) t
       WHERE score_num IS NOT NULL`,
      [userId],
      "val",
    );

    const compliancePrev = await safeNumber(
      `SELECT ROUND(AVG(score_num), 0) AS val
       FROM (
         SELECT
           CASE
             WHEN JSON_EXTRACT(ao.payload_json, '$.overall_score') IS NOT NULL
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.overall_score')) AS DECIMAL(10,2))
             WHEN JSON_EXTRACT(ao.payload_json, '$.compliance_score') IS NOT NULL
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(ao.payload_json, '$.compliance_score')) AS DECIMAL(10,2))
             ELSE NULL
           END AS score_num
         FROM agent_outputs ao
         INNER JOIN cases c ON c.id = ao.case_id
         WHERE c.user_id = ?
           AND ao.agent_key = 'policy_compliance'
           AND ao.updated_at >= (UTC_TIMESTAMP() - INTERVAL 60 DAY)
           AND ao.updated_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)
       ) t
       WHERE score_num IS NOT NULL`,
      [userId],
      "val",
    );
    const complianceDelta = complianceScore - compliancePrev;

    const resolutionTotal = await safeNumber(
      `SELECT COUNT(*) AS val
       FROM runs r
       INNER JOIN cases c ON c.id = r.case_id
       WHERE c.user_id = ?
         AND r.created_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
         AND (
           r.steps_json LIKE '%\"agent_key\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"name\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"agent_key\":\"case_outcome_prediction\"%'
         )`,
      [userId],
      "val",
    );
    const resolutionSuccess = await safeNumber(
      `SELECT SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS val
       FROM runs r
       INNER JOIN cases c ON c.id = r.case_id
       WHERE c.user_id = ?
         AND r.created_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
         AND (
           r.steps_json LIKE '%\"agent_key\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"name\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"agent_key\":\"case_outcome_prediction\"%'
         )`,
      [userId],
      "val",
    );
    const resolutionRate = resolutionTotal > 0 ? Math.round((resolutionSuccess / resolutionTotal) * 100) : 0;

    const resolutionPrevTotal = await safeNumber(
      `SELECT COUNT(*) AS val
       FROM runs r
       INNER JOIN cases c ON c.id = r.case_id
       WHERE c.user_id = ?
         AND r.created_at >= (UTC_TIMESTAMP() - INTERVAL 60 DAY)
         AND r.created_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)
         AND (
           r.steps_json LIKE '%\"agent_key\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"name\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"agent_key\":\"case_outcome_prediction\"%'
         )`,
      [userId],
      "val",
    );
    const resolutionPrevSuccess = await safeNumber(
      `SELECT SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS val
       FROM runs r
       INNER JOIN cases c ON c.id = r.case_id
       WHERE c.user_id = ?
         AND r.created_at >= (UTC_TIMESTAMP() - INTERVAL 60 DAY)
         AND r.created_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)
         AND (
           r.steps_json LIKE '%\"agent_key\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"name\":\"outcome_projection\"%'
           OR r.steps_json LIKE '%\"agent_key\":\"case_outcome_prediction\"%'
         )`,
      [userId],
      "val",
    );
    const resolutionPrevRate = resolutionPrevTotal > 0 ? Math.round((resolutionPrevSuccess / resolutionPrevTotal) * 100) : 0;
    const resolutionDelta = resolutionRate - resolutionPrevRate;

    return {
      active_contracts: activeContracts,
      active_contracts_delta_week: activeContractsWeeklyDelta,
      high_risk_cases: highRiskCases,
      high_risk_delta_week: highRiskDelta,
      compliance_score: Math.max(0, Math.min(100, complianceScore)),
      compliance_delta_month: complianceDelta,
      resolution_rate: Math.max(0, Math.min(100, resolutionRate)),
      resolution_delta_month: resolutionDelta,
    };
  },

  async getCaseById(userId: string, caseId: string, languageOverride?: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, "User not found", "user_not_found");
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        documents: { orderBy: { createdAt: "asc" } },
        outputs: { orderBy: { updatedAt: "asc" } },
        runs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");

    const language = languageOverride || user.preferredLanguage || c.language || "English";
    const outputsMap: Record<string, any> = {};
    let finalSummary: any = null;
    let finalSummarySourceLanguage: string | null = null;
    const qpRaw = ((c.outputs || []).find((o: any) => o.agentKey === "query_parsing")?.payloadJson as any) || null;
    const primaryRoleDoc =
      c.documents.find((d: any) => String(d.id || "") === String((c as any).primaryDocId || "")) ||
      c.documents.find((d: any) => String(d.extractedText || "").trim().length > 0) ||
      c.documents[0] ||
      null;
    const roleDisplaySnippets = buildRoleDisplaySnippets(primaryRoleDoc);
    for (const output of c.outputs) {
      const rawPayload = output.payloadJson as any;
      const payload = ALL_ROLE_AGENT_KEYS.includes(output.agentKey)
        ? normalizeRoleAgentPayloadForDisplay(output.agentKey as any, rawPayload, c.title, roleDisplaySnippets, qpRaw)
        : ROLE_AWARE_COMMON_KEYS.has(output.agentKey)
          ? applyRoleAwareCommonPayload(output.agentKey as any, rawPayload, user.role as any)
          : rawPayload;
      if (output.agentKey === "final_summary") {
        finalSummary = payload;
        finalSummarySourceLanguage = (output as any).sourceLanguage || null;
      } else {
        outputsMap[output.agentKey] = translatorService.translatePayload(payload, language, (output as any).sourceLanguage || null);
      }
    }
    const translatedOutputs = outputsMap;
    const translatedFinal = finalSummary
      ? translatorService.translatePayload(finalSummary, language, finalSummarySourceLanguage)
      : null;
    const latestRun = c.runs[0] ?? null;
    const agentStatus = deriveAgentStatus(c.outputs.map((o: any) => ({ agentKey: o.agentKey, updatedAt: o.updatedAt })), latestRun);
    const translatedStatus = Object.fromEntries(
      Object.entries(agentStatus).map(([k, v]) => [k, { state: v.state, updated_at: v.updated_at }]),
    );

    const qpDetected = (translatedOutputs as any)?.query_parsing?.detected_language;
    const qpDetectedCode = typeof qpDetected === "object" ? qpDetected.code : null;
    const qpDetectedConf = typeof qpDetected === "object" ? qpDetected.confidence : null;
    return {
      case_id: c.id,
      title: c.title,
      status: String((c as any).status || "active"),
      domain_primary: (c as any).domainPrimary || null,
      domain_subtype: (c as any).domainSubtype || null,
      primary_doc_id: (c as any).primaryDocId || null,
      role: ROLE_TO_FRONTEND[user.role as keyof typeof ROLE_TO_FRONTEND],
      language,
      detectedLanguage: c.detectedLanguage || "Unknown",
      detectedLanguageCode: qpDetectedCode || detectLanguageInfo(c.documents.map((d: any) => d.extractedText || "").join(" ").slice(0, 2000)).code,
      detectedLanguageConfidence: typeof qpDetectedConf === "number" ? qpDetectedConf : undefined,
      filtersApplied: (c.filtersJson as any) || {},
      created_at: c.createdAt.toISOString(),
      documents: c.documents.map((d: any) => ({
        doc_id: d.id,
        name: d.name,
        type: d.mime,
        size: d.size,
        detectedLanguage: d.detectedLanguage || "Unknown",
        detectedLanguageCode: detectLanguageInfo(d.extractedText || "").code,
        detectedLanguageConfidence: detectLanguageInfo(d.extractedText || "").confidence,
        created_at: d.createdAt.toISOString(),
      })),
      agent_status: translatedStatus,
      outputs: translatedOutputs,
      final_summary: translatedFinal,
    };
  },

  async getPrimaryDocument(userId: string, caseId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const primary = await resolvePrimaryCaseDocumentMeta(caseId);
    if (!primary) throw new HttpError(404, "Primary document not found", "primary_document_not_found");
    return {
      doc_id: primary.doc_id,
      filename: primary.filename,
      mime_type: primary.mime_type,
      kind: primary.kind,
      pages: primary.pages,
      extracted_text_exists: String(primary.extracted_text || "").trim().length > 0,
      updated_at: primary.updated_at,
    };
  },

  async getQueryParsingOutput(userId: string, caseId: string) {
    const [user, c] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } }),
    ]);
    if (!user) throw new HttpError(404, "User not found", "user_not_found");
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const qp = (c.outputs || []).find((o: any) => o.agentKey === "query_parsing");
    if (!qp) throw new HttpError(404, "Query Parsing output not found", "query_parsing_output_not_found");
    return applyRoleAwareCommonPayload("query_parsing", qp.payloadJson as any, user.role as any);
  },

  async getDocumentById(userId: string, caseId: string, docId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const rawDoc = (await prisma.document.findMany({
      where: { caseId },
      select: { id: true, size: true, path: true, createdAt: true, updatedAt: true },
    })).find((doc: any) => String(doc?.id || "") === docId);
    if (!rawDoc) throw new HttpError(404, "Document not found", "document_not_found");
    const doc = await resolveCaseDocumentMeta(caseId, docId);
    if (!doc) throw new HttpError(404, "Document not found", "document_not_found");
    return {
      doc_id: doc.doc_id,
      case_id: caseId,
      name: doc.filename,
      mime_type: doc.mime_type,
      size: rawDoc.size,
      path: rawDoc.path || doc.path,
      kind: doc.kind || null,
      created_at: rawDoc.createdAt.toISOString(),
      updated_at: rawDoc.updatedAt.toISOString(),
      detected_language: doc.language || "Unknown",
      extracted_text_exists: String(doc.extracted_text || "").trim().length > 0,
      extracted_text: doc.extracted_text,
      pages: doc.pages,
    };
  },

  async renderQueryParsingExportHtml(userId: string, caseId: string) {
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        outputs: { orderBy: { updatedAt: "asc" } },
        documents: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, "User not found", "user_not_found");
    const qpRaw = (c.outputs.find((o: any) => o.agentKey === "query_parsing")?.payloadJson as any) || null;
    const qp = qpRaw ? applyRoleAwareCommonPayload("query_parsing", qpRaw, user.role as any) : null;
    if (!qp) throw new HttpError(404, "Query Parsing output not found", "query_parsing_output_not_found");

    const d = qpDisplay(qp);
    const caseTitle = String(qp?.case_title || c.title || "Query Parsing Report").trim();
    const queryText = String(qp?.submitted_query || "").trim();
    const currentInputCitations = d.citations.filter((x: any) => String(x?.source_label || "").toUpperCase() === "CURRENT_INPUT" || String(x?.source_type || "").toLowerCase() === "current_input");
    const citations = d.citations.slice(0, Math.max(3, d.citations.length));
    const legalGrounds = d.legalGrounds.slice(0, 7);
    const createdAt = new Date().toLocaleString("en-IN");
    const docs = c.documents
      .filter((doc: any) => String(doc.name || "").toLowerCase() !== "query-context")
      .slice(0, 10)
      .map((doc: any) => `<li>${escHtml(doc.name)} <span class="muted">(${escHtml(doc.mime || "file")})</span></li>`)
      .join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(caseTitle)} - Query Parsing Report</title>
  <style>
    :root { --bg:#f6f8fc; --card:#ffffff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --blue:#2563eb; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 "Segoe UI", system-ui, sans-serif; }
    .wrap { max-width:980px; margin:24px auto; padding:0 16px; }
    .toolbar { display:flex; justify-content:flex-end; gap:8px; margin-bottom:12px; }
    .btn { border:1px solid var(--line); background:#fff; padding:8px 12px; border-radius:10px; cursor:pointer; font-weight:600; }
    .btn.primary { background:var(--blue); color:#fff; border-color:var(--blue); }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
    .header h1 { margin:0 0 4px; font-size:24px; }
    .header p { margin:0; color:var(--muted); }
    .grid { display:grid; grid-template-columns:1.4fr .8fr; gap:14px; }
    .kpi { font-size:40px; font-weight:700; color:var(--blue); line-height:1; }
    .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .chip { border:1px solid var(--line); border-radius:999px; padding:4px 10px; color:#0f172a; background:#f8fafc; font-size:12px; }
    .title { margin:0 0 10px; font-size:16px; font-weight:700; }
    .muted { color:var(--muted); }
    .quote { white-space:pre-wrap; background:#f8fafc; border:1px solid var(--line); padding:12px; border-radius:10px; }
    ul { margin:8px 0 0; padding-left:18px; }
    li { margin:6px 0; }
    .cit { border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:8px; background:#fbfdff; }
    .cit .meta { font-size:12px; color:var(--muted); margin-bottom:4px; text-transform:uppercase; letter-spacing:.04em; }
    .footer { color:var(--muted); font-size:12px; margin-top:10px; text-align:right; }
    @media print {
      body { background:#fff; }
      .wrap { margin:0; max-width:none; padding:0; }
      .toolbar { display:none; }
      .card { break-inside:avoid; box-shadow:none; }
    }
    @media (max-width: 820px) { .grid { grid-template-columns:1fr; } .kpi { font-size:32px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <button class="btn" onclick="window.close()">Close</button>
      <button class="btn primary" onclick="window.print()">Save / Print PDF</button>
    </div>
    <div class="card header">
      <h1>Legal Analysis Report</h1>
      <p>${escHtml(caseTitle)} • Query Parsing Report</p>
    </div>
    <div class="grid">
      <div>
        <div class="card">
          <div class="title">Submitted Case Query</div>
          <div class="quote">${escHtml(queryText || (currentInputCitations[0]?.snippet || "No current input text captured."))}</div>
          <div class="chips">
            <span class="chip">Jurisdiction: ${escHtml(d.jurisdiction)}</span>
            <span class="chip">Domain: ${escHtml(d.domain)}</span>
            <span class="chip">Language: ${escHtml(d.language)}</span>
          </div>
        </div>
        <div class="card">
          <div class="title">Executive Summary</div>
          <div>${escHtml(d.summary)}</div>
        </div>
        <div class="card">
          <div class="title">Legal Grounds (Issue Labels)</div>
          ${legalGrounds.length ? `<ul>${legalGrounds.map((g: any) => `<li>${escHtml(g)}</li>`).join("")}</ul>` : `<div class="muted">No issue labels available.</div>`}
        </div>
        <div class="card">
          <div class="title">Relevant Citations</div>
          ${citations.length ? citations.map((c: any) => `
            <div class="cit">
              <div class="meta">${escHtml(String(c.source_label || c.source_type || "SOURCE"))}${c.page ? ` • Page ${escHtml(c.page)}` : ""}</div>
              <div>${escHtml(c.snippet || "")}</div>
            </div>
          `).join("") : `<div class="muted">No citations available.</div>`}
        </div>
      </div>
      <div>
        <div class="card">
          <div class="title">Confidence</div>
          <div class="kpi">${escHtml(d.confidencePct)}%</div>
          <div class="muted" style="margin-top:8px;">Query Parsing assessment confidence based on provided case inputs.</div>
        </div>
        <div class="card">
          <div class="title">Case Files Used</div>
          ${docs ? `<ul>${docs}</ul>` : `<div class="muted">No uploaded documents for this case (query-only run).</div>`}
        </div>
      </div>
    </div>
    <div class="footer">Generated ${escHtml(createdAt)} • AGENTIC OMNI LAW</div>
  </div>
  <script>
    try {
      const params = new URLSearchParams(location.search);
      if (params.get("autoprint") === "1") setTimeout(() => window.print(), 300);
    } catch {}
  </script>
</body>
</html>`;
  },
  async renderQueryParsingExportPdf(userId: string, caseId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError(404, "User not found", "user_not_found");
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        outputs: { orderBy: { updatedAt: "asc" } },
        documents: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const qpRaw = (c.outputs.find((o: any) => o.agentKey === "query_parsing")?.payloadJson as any) || null;
    const qp = qpRaw ? applyRoleAwareCommonPayload("query_parsing", qpRaw, user.role as any) : null;
    if (!qp) throw new HttpError(404, "Query Parsing output not found", "query_parsing_output_not_found");

    const d = qpDisplay(qp);
    const caseTitle = String(qp?.case_title || c.title || "Query Parsing Report").trim();
    const queryText = String(qp?.submitted_query || "").trim();
    const currentInputCitations = d.citations.filter(
      (x: any) => String(x?.source_label || "").toUpperCase() === "CURRENT_INPUT" || String(x?.source_type || "").toLowerCase() === "current_input",
    );
    const citations = d.citations.slice(0, Math.max(3, d.citations.length));
    const legalGrounds = d.legalGrounds.slice(0, 7);
    const docs = c.documents
      .filter((doc: any) => String(doc.name || "").toLowerCase() !== "query-context")
      .slice(0, 10)
      .map((doc: any) => `${doc.name} (${doc.mime || "file"})`);

    const buffer = await createPdfBuffer((doc, h) => {
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text("Query Parsing Report", { width: h.pageWidth });
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${caseId}`, { width: h.pageWidth });
      doc.text(`Case Title: ${toSingleLine(caseTitle)}`, { width: h.pageWidth });
      doc.text(`Generated At: ${toDateTime(new Date().toISOString())}`, { width: h.pageWidth });
      doc.moveDown(0.35);

      h.heading("Submitted Case Query");
      h.paragraph(queryText || currentInputCitations[0]?.snippet || "No current input text captured.");
      h.line("Jurisdiction", d.jurisdiction);
      h.line("Domain", d.domain);
      h.line("Language", d.language);

      h.heading("Executive Summary");
      h.paragraph(d.summary || "No executive summary available.");

      h.heading("Legal Grounds (Issue Labels)");
      h.bullets(legalGrounds, 8);

      h.heading("Confidence");
      h.line("Confidence Score", `${d.confidencePct}%`);

      h.heading("Case Files Used");
      if (!docs.length) {
        h.paragraph("No uploaded documents for this case (query-only run).");
      } else {
        h.bullets(docs, 8);
      }

      h.heading("Relevant Citations");
      if (!citations.length) {
        h.paragraph("No citations available.");
      } else {
        h.bullets(
          citations.map((c: any) => {
            const label = toSingleLine(String(c.source_label || c.source_type || "SOURCE"));
            const snippet = shortenText(c.snippet || "", 220);
            const page = c.page ? ` (p.${c.page})` : "";
            return `${label}${page}: ${snippet}`;
          }),
          8,
        );
      }
    });

    return { buffer, filename: `query-parsing-${String(caseId || "report")}.pdf` };
  },
};
