import { randomUUID } from "crypto";
import { mysqlPool } from "../../prisma/client.js";

export type AgentOutputStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export const agentOutputsRepo = {
  async getRoleOutput(params: { caseId: string; agentKey: string; docHash: string; outputLang: string; profile: string }) {
    const [rows]: any = await mysqlPool.query(
      `SELECT * FROM agent_outputs
       WHERE case_id = ?
         AND agent_key = ?
         AND COALESCE(doc_hash,'') = ?
         AND COALESCE(output_lang,'English') = ?
         AND COALESCE(profile,'standard') = ?
       ORDER BY
         CASE COALESCE(status, 'PENDING')
           WHEN 'SUCCEEDED' THEN 0
           WHEN 'FAILED' THEN 1
           WHEN 'RUNNING' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT 1`,
      [params.caseId, params.agentKey, params.docHash || "", params.outputLang || "English", params.profile || "standard"],
    );
    return rows?.[0] || null;
  },

  async getLatestRoleOutput(params: { caseId: string; agentKey: string; outputLang: string; profile: string }) {
    const [rows]: any = await mysqlPool.query(
      `SELECT * FROM agent_outputs
       WHERE case_id = ?
         AND agent_key = ?
         AND COALESCE(output_lang,'English') = ?
         AND COALESCE(profile,'standard') = ?
       ORDER BY
         CASE COALESCE(status, 'PENDING')
           WHEN 'SUCCEEDED' THEN 0
           WHEN 'FAILED' THEN 1
           WHEN 'RUNNING' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT 1`,
      [params.caseId, params.agentKey, params.outputLang || "English", params.profile || "standard"],
    );
    return rows?.[0] || null;
  },

  async getLatestRoleOutputAny(params: { caseId: string; agentKey: string }) {
    const [rows]: any = await mysqlPool.query(
      `SELECT * FROM agent_outputs
       WHERE case_id = ?
         AND agent_key = ?
       ORDER BY
         CASE COALESCE(status, 'PENDING')
           WHEN 'SUCCEEDED' THEN 0
           WHEN 'FAILED' THEN 1
           WHEN 'RUNNING' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT 1`,
      [params.caseId, params.agentKey],
    );
    return rows?.[0] || null;
  },

  async upsertRoleOutput(params: {
    caseId: string;
    agentKey: string;
    docId: string | null;
    docHash: string;
    outputLang: string;
    profile: string;
    runId: string | null;
    status: AgentOutputStatus;
    analysisValid: boolean;
    failureReason: string | null;
    payload: any;
  }) {
    await mysqlPool.query(
      `INSERT INTO agent_outputs (
          id, case_id, agent_key, agent_kind, doc_id, doc_hash, output_lang, profile,
          run_id, status, analysis_valid, failure_reason, payload_json, source_language, created_at, updated_at
        ) VALUES (?, ?, ?, 'role', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE
          agent_kind='role',
          doc_id=VALUES(doc_id),
          doc_hash=VALUES(doc_hash),
          output_lang=VALUES(output_lang),
          profile=VALUES(profile),
          run_id=VALUES(run_id),
          status=VALUES(status),
          analysis_valid=VALUES(analysis_valid),
          failure_reason=VALUES(failure_reason),
          payload_json=VALUES(payload_json),
          source_language=VALUES(source_language),
          updated_at=NOW(3)`,
      [
        randomUUID(),
        params.caseId,
        params.agentKey,
        params.docId,
        params.docHash || "",
        params.outputLang || "English",
        params.profile || "standard",
        params.runId,
        params.status,
        params.analysisValid ? 1 : 0,
        params.failureReason,
        JSON.stringify(params.payload || {}),
        params.outputLang || "English",
      ],
    );
  },
};
