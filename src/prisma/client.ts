import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { randomUUID } from "crypto";
import { getEnv } from "../config/env.js";

type AnyObj = Record<string, any>;

declare global {
  // eslint-disable-next-line no-var
  var __agenticMysqlPool: Pool | undefined;
}

const env = getEnv();

function parseMysqlUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, ""),
  };
}

const cfg = parseMysqlUrl(env.databaseUrl);
const pool =
  global.__agenticMysqlPool ??
  mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: 10,
    namedPlaceholders: false,
    dateStrings: false,
  });
if (process.env.NODE_ENV !== "production") global.__agenticMysqlPool = pool;

function nowDate(v?: any): Date {
  return v instanceof Date ? v : new Date(v);
}
function parseJson<T = any>(v: any): T {
  if (v == null) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  }
  return v as T;
}
function toUser(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    gender: row.gender ?? null,
    dateOfBirth: row.date_of_birth ? nowDate(row.date_of_birth) : null,
    passwordHash: row.password_hash,
    role: row.role,
    isVerified: !!row.is_verified,
    preferredLanguage: row.preferred_language,
    activeCaseId: row.active_case_id ?? null,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toOtp(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    codeHash: row.code_hash,
    expiresAt: nowDate(row.expires_at),
    attempts: row.attempts,
    lastSentAt: nowDate(row.last_sent_at),
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toCase(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    language: row.language,
    detectedLanguage: row.detected_language,
    filtersJson: parseJson(row.filters_json),
    title: row.title,
    status: row.status ?? "active",
    domainPrimary: row.domain_primary ?? null,
    domainSubtype: row.domain_subtype ?? null,
    primaryDocId: row.primary_doc_id ?? null,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toDocument(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    path: row.path,
    kind: row.kind,
    checksum: row.checksum,
    indexedChecksum: row.indexed_checksum,
    extractedText: row.extracted_text,
    detectedLanguage: row.detected_language,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toIndexChunk(row: any) {
  return {
    id: row.id,
    caseId: row.case_id,
    docId: row.doc_id,
    chunkId: row.chunk_id,
    chunkText: row.chunk_text,
    metaJson: parseJson(row.meta_json),
    createdAt: nowDate(row.created_at),
  };
}
function toRun(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    status: row.status,
    language: row.language,
    stepsJson: parseJson(row.steps_json),
    startedAt: row.started_at ? nowDate(row.started_at) : null,
    finishedAt: row.finished_at ? nowDate(row.finished_at) : null,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toAgentOutput(row: any) {
  return {
    id: row.id,
    caseId: row.case_id,
    agentKey: row.agent_key,
    payloadJson: parseJson(row.payload_json),
    sourceLanguage: row.source_language,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}
function toNotification(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at ? nowDate(row.read_at) : null,
    createdAt: nowDate(row.created_at),
    updatedAt: nowDate(row.updated_at),
  };
}

async function q<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, params: any[] = [], conn?: PoolConnection) {
  const executor = conn ?? pool;
  const [rows] = await executor.query<T>(sql, params);
  return rows;
}

async function q1<T extends RowDataPacket = RowDataPacket>(sql: string, params: any[] = [], conn?: PoolConnection) {
  const rows = await q<RowDataPacket[]>(sql, params, conn);
  return (rows[0] as T) ?? null;
}

function sqlSet(data: AnyObj, map: Record<string, string>) {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(data)) {
    const col = map[k];
    if (!col) continue;
    if (v && typeof v === "object" && "increment" in v) {
      sets.push(`${col} = ${col} + ?`);
      values.push((v as any).increment);
    } else if (col.endsWith("_json")) {
      sets.push(`${col} = ?`);
      values.push(v == null ? null : JSON.stringify(v));
    } else {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  return { sets, values };
}

function firstOrder(orderBy: any): [string, "ASC" | "DESC"] | null {
  if (!orderBy) return null;
  const [key, val] = Object.entries(orderBy)[0] as [string, any];
  if (typeof val === "string") return [key, val.toUpperCase() === "DESC" ? "DESC" : "ASC"];
  if (val && typeof val === "object" && "sort" in val) return [key, String((val as any).sort).toUpperCase() === "DESC" ? "DESC" : "ASC"];
  return [key, "ASC"];
}

async function withTx<T>(fn: (conn: PoolConnection) => Promise<T>) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export const prisma: any = {
  async $connect() {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
  },
  async $disconnect() {
    await pool.end();
  },
  user: {
    async findUnique(args: any) {
      if (args.where?.id) return toUser(await q1("SELECT * FROM users WHERE id = ? LIMIT 1", [args.where.id]));
      return null;
    },
    async findFirst(args: any) {
      const or = args.where?.OR ?? [];
      const clauses: string[] = [];
      const params: any[] = [];
      for (const item of or) {
        if (item.email !== undefined) {
          clauses.push("email = ?");
          params.push(item.email);
        }
        if (item.phone !== undefined) {
          clauses.push("phone = ?");
          params.push(item.phone);
        }
      }
      if (!clauses.length) return null;
      return toUser(await q1(`SELECT * FROM users WHERE ${clauses.map((c) => `(${c})`).join(" OR ")} LIMIT 1`, params));
    },
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO users (id,name,email,phone,gender,date_of_birth,password_hash,role,is_verified,preferred_language,active_case_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [
          id,
          d.name,
          d.email,
          d.phone ?? null,
          d.gender ?? null,
          d.dateOfBirth ?? null,
          d.passwordHash,
          d.role,
          d.isVerified ? 1 : 0,
          d.preferredLanguage ?? "English",
          d.activeCaseId ?? null,
        ],
      );
      return toUser(await q1("SELECT * FROM users WHERE id = ?", [id]));
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, {
        name: "name",
        email: "email",
        phone: "phone",
        gender: "gender",
        dateOfBirth: "date_of_birth",
        passwordHash: "password_hash",
        role: "role",
        isVerified: "is_verified",
        preferredLanguage: "preferred_language",
        activeCaseId: "active_case_id",
      });
      sets.push("updated_at = NOW(3)");
      await q(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toUser(await q1("SELECT * FROM users WHERE id = ?", [args.where.id]));
    },
  },
  otp: {
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO otps (id,user_id,code_hash,expires_at,attempts,last_sent_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,NOW(3),NOW(3))`,
        [id, d.userId, d.codeHash, d.expiresAt, d.attempts ?? 0, d.lastSentAt ?? new Date()],
      );
      return toOtp(await q1("SELECT * FROM otps WHERE id = ?", [id]));
    },
    async findFirst(args: any) {
      const userId = args.where?.userId;
      const order = firstOrder(args.orderBy);
      const sql = `SELECT * FROM otps WHERE user_id = ? ${order ? `ORDER BY ${order[0] === "createdAt" ? "created_at" : "created_at"} ${order[1]}` : ""} LIMIT 1`;
      return toOtp(await q1(sql, [userId]));
    },
    async count(args: any) {
      const userId = args.where?.userId;
      const gte = args.where?.createdAt?.gte;
      const row: any = await q1("SELECT COUNT(*) as c FROM otps WHERE user_id = ? AND created_at >= ?", [userId, gte]);
      return Number(row?.c ?? 0);
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, { attempts: "attempts", lastSentAt: "last_sent_at" });
      sets.push("updated_at = NOW(3)");
      await q(`UPDATE otps SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toOtp(await q1("SELECT * FROM otps WHERE id = ?", [args.where.id]));
    },
  },
  case: {
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO cases (id,user_id,role,language,detected_language,filters_json,title,status,domain_primary,domain_subtype,primary_doc_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [id, d.userId, d.role, d.language ?? "English", d.detectedLanguage ?? null, d.filtersJson ? JSON.stringify(d.filtersJson) : null, d.title, d.status ?? "active", d.domainPrimary ?? null, d.domainSubtype ?? null, d.primaryDocId ?? null],
      );
      return toCase(await q1("SELECT * FROM cases WHERE id = ?", [id]));
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, {
        role: "role",
        language: "language",
        detectedLanguage: "detected_language",
        filtersJson: "filters_json",
        title: "title",
        status: "status",
        domainPrimary: "domain_primary",
        domainSubtype: "domain_subtype",
        primaryDocId: "primary_doc_id",
        updatedAt: "updated_at",
      });
      if (!sets.some((s) => s.startsWith("updated_at"))) sets.push("updated_at = NOW(3)");
      await q(`UPDATE cases SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toCase(await q1("SELECT * FROM cases WHERE id = ?", [args.where.id]));
    },
    async findUnique(args: any) {
      const base = toCase(await q1("SELECT * FROM cases WHERE id = ? LIMIT 1", [args.where.id]));
      if (!base) return null;
      const include = args.include || {};
      const out: any = { ...base };
      if (include.documents) {
        const order = firstOrder(include.documents.orderBy);
        const rows = await q(
          `SELECT * FROM documents WHERE case_id = ? ${order ? `ORDER BY ${order[0] === "createdAt" ? "created_at" : "created_at"} ${order[1]}` : ""}`,
          [base.id],
        );
        out.documents = (rows as any[]).map(toDocument);
      }
      if (include.outputs) {
        const rows = await q("SELECT * FROM agent_outputs WHERE case_id = ? ORDER BY updated_at ASC", [base.id]);
        out.outputs = (rows as any[]).map(toAgentOutput);
      }
      if (include.runs) {
        const take = include.runs.take ? Number(include.runs.take) : undefined;
        const rows = await q(
          `SELECT * FROM runs WHERE case_id = ? ORDER BY created_at DESC ${take ? `LIMIT ${take}` : ""}`,
          [base.id],
        );
        out.runs = (rows as any[]).map(toRun);
      }
      if (include.user) {
        out.user = toUser(await q1("SELECT * FROM users WHERE id = ?", [base.userId]));
      }
      return out;
    },
    async findMany(args: any) {
      const whereUserId = args.where?.userId;
      const order = firstOrder(args.orderBy);
      const take = args.take ? Number(args.take) : undefined;
      const rows = await q(
        `SELECT * FROM cases ${whereUserId ? "WHERE user_id = ?" : ""} ${order ? `ORDER BY ${order[0] === "updatedAt" ? "updated_at" : "created_at"} ${order[1]}` : ""} ${take ? `LIMIT ${take}` : ""}`,
        whereUserId ? [whereUserId] : [],
      );
      const cases = (rows as any[]).map(toCase).filter(Boolean) as any[];
      if (!args.include) return cases;
      const out: any[] = [];
      for (const c of cases) {
        const row: any = { ...c };
        if (args.include.outputs) {
          const select = args.include.outputs.select || null;
          const orows = await q("SELECT * FROM agent_outputs WHERE case_id = ?", [c.id]);
          row.outputs = (orows as any[]).map((r) => {
            const o = toAgentOutput(r) as any;
            if (!select) return o;
            const slim: any = {};
            if (select.agentKey) slim.agentKey = o.agentKey;
            if (select.payloadJson) slim.payloadJson = o.payloadJson;
            return slim;
          });
        }
        if (args.include.runs) {
          const takeRuns = args.include.runs.take ? Number(args.include.runs.take) : undefined;
          const rrows = await q(`SELECT * FROM runs WHERE case_id = ? ORDER BY created_at DESC ${takeRuns ? `LIMIT ${takeRuns}` : ""}`, [c.id]);
          row.runs = (rrows as any[]).map((r) => {
            const rr = toRun(r) as any;
            const select = args.include.runs.select;
            if (!select) return rr;
            const slim: any = {};
            if (select.status) slim.status = rr.status;
            return slim;
          });
        }
        out.push(row);
      }
      return out;
    },
  },
  document: {
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO documents (id,case_id,name,mime,size,path,kind,checksum,indexed_checksum,extracted_text,detected_language,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [id, d.caseId, d.name, d.mime, d.size, d.path, d.kind, d.checksum, d.indexedChecksum ?? null, d.extractedText ?? null, d.detectedLanguage ?? null],
      );
      return toDocument(await q1("SELECT * FROM documents WHERE id = ?", [id]));
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, {
        indexedChecksum: "indexed_checksum",
        extractedText: "extracted_text",
        detectedLanguage: "detected_language",
        updatedAt: "updated_at",
      });
      if (!sets.some((s) => s.startsWith("updated_at"))) sets.push("updated_at = NOW(3)");
      await q(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toDocument(await q1("SELECT * FROM documents WHERE id = ?", [args.where.id]));
    },
    async findMany(args: any) {
      const where = args.where || {};
      const clauses: string[] = [];
      const params: any[] = [];
      if (where.caseId !== undefined) {
        clauses.push("case_id = ?");
        params.push(where.caseId);
      }
      const order = firstOrder(args.orderBy);
      const select = args.select;
      const rows = await q(
        `SELECT * FROM documents ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ${order ? `ORDER BY ${order[0] === "createdAt" ? "created_at" : "updated_at"} ${order[1]}` : ""}`,
        params,
      );
      const mapped = (rows as any[]).map(toDocument);
      if (!select) return mapped;
      return mapped.map((d) => {
        const slim: any = {};
        for (const [k, enabled] of Object.entries(select)) if (enabled) slim[k] = (d as any)[k];
        return slim;
      });
    },
    async delete(args: any) {
      const row = await q1("SELECT * FROM documents WHERE id = ? LIMIT 1", [args.where.id]);
      if (!row) return null;
      await q("DELETE FROM documents WHERE id = ?", [args.where.id]);
      return toDocument(row);
    },
    async deleteMany(args: any) {
      const where = args.where || {};
      const clauses: string[] = [];
      const params: any[] = [];
      if (where.id !== undefined) {
        clauses.push("id = ?");
        params.push(where.id);
      }
      if (where.caseId !== undefined) {
        clauses.push("case_id = ?");
        params.push(where.caseId);
      }
      if (where.kind !== undefined) {
        clauses.push("kind = ?");
        params.push(where.kind);
      }
      if (where.name !== undefined) {
        clauses.push("name = ?");
        params.push(where.name);
      }
      const [result]: any = await pool.query(`DELETE FROM documents ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`, params);
      return { count: result.affectedRows ?? 0 };
    },
  },
  indexChunk: {
    async deleteMany(args: any) {
      const where = args.where || {};
      const clauses: string[] = [];
      const params: any[] = [];
      if (where.caseId !== undefined) {
        clauses.push("case_id = ?");
        params.push(where.caseId);
      }
      if (where.docId !== undefined) {
        clauses.push("doc_id = ?");
        params.push(where.docId);
      }
      const [result]: any = await pool.query(`DELETE FROM index_chunks ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`, params);
      return { count: result.affectedRows ?? 0 };
    },
    async createMany(args: any) {
      const rows = args.data || [];
      if (!rows.length) return { count: 0 };
      const placeholders = rows.map(() => "(?,?,?,?,?,?,NOW(3))").join(",");
      const vals: any[] = [];
      for (const r of rows) {
        vals.push(randomUUID(), r.caseId, r.docId, r.chunkId, r.chunkText, r.metaJson ? JSON.stringify(r.metaJson) : null);
      }
      const insert = `INSERT ${args.skipDuplicates ? "IGNORE " : ""}INTO index_chunks (id,case_id,doc_id,chunk_id,chunk_text,meta_json,created_at) VALUES ${placeholders}`;
      const [result]: any = await pool.query(insert, vals);
      return { count: result.affectedRows ?? 0 };
    },
    async findMany(args: any) {
      const where = args.where || {};
      const clauses: string[] = [];
      const params: any[] = [];
      if (where.caseId !== undefined) {
        clauses.push("case_id = ?");
        params.push(where.caseId);
      }
      const order = firstOrder(args.orderBy);
      const take = args.take ? Number(args.take) : undefined;
      const sql = `SELECT * FROM index_chunks ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ${order ? `ORDER BY ${order[0] === "createdAt" ? "created_at" : "created_at"} ${order[1]}` : ""} ${take ? `LIMIT ${take}` : ""}`;
      const rows = await q(sql, params);
      return (rows as any[]).map(toIndexChunk);
    },
  },
  run: {
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO runs (id,case_id,status,language,steps_json,started_at,finished_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [id, d.caseId, d.status, d.language ?? null, JSON.stringify(d.stepsJson), d.startedAt ?? null, d.finishedAt ?? null],
      );
      return toRun(await q1("SELECT * FROM runs WHERE id = ?", [id]));
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, {
        status: "status",
        language: "language",
        stepsJson: "steps_json",
        startedAt: "started_at",
        finishedAt: "finished_at",
        updatedAt: "updated_at",
      });
      if (!sets.some((s) => s.startsWith("updated_at"))) sets.push("updated_at = NOW(3)");
      await q(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toRun(await q1("SELECT * FROM runs WHERE id = ?", [args.where.id]));
    },
    async findUnique(args: any) {
      const base = toRun(await q1("SELECT * FROM runs WHERE id = ? LIMIT 1", [args.where.id]));
      if (!base) return null;
      if (!args.include) return base;
      const out: any = { ...base };
      if (args.include.case) {
        const c = await prisma.case.findUnique({
          where: { id: base.caseId },
          include: args.include.case.include ? { user: !!args.include.case.include.user } : undefined,
        });
        out.case = c;
      }
      return out;
    },
  },
  agentOutput: {
    async upsert(args: any) {
      const { caseId, agentKey } = args.where.caseId_agentKey;
      const existing = await q1("SELECT * FROM agent_outputs WHERE case_id = ? AND agent_key = ? LIMIT 1", [caseId, agentKey]);
      if (!existing) {
        const d = args.create;
        const id = randomUUID();
        await q(
          `INSERT INTO agent_outputs (id,case_id,agent_key,payload_json,source_language,created_at,updated_at)
           VALUES (?,?,?,?,?,NOW(3),NOW(3))`,
          [id, d.caseId, d.agentKey, JSON.stringify(d.payloadJson), d.sourceLanguage ?? "en"],
        );
        return toAgentOutput(await q1("SELECT * FROM agent_outputs WHERE id = ?", [id]));
      }
      const d = args.update;
      await q("UPDATE agent_outputs SET payload_json = ?, source_language = ?, updated_at = NOW(3) WHERE case_id = ? AND agent_key = ?", [
        JSON.stringify(d.payloadJson),
        d.sourceLanguage ?? "en",
        caseId,
        agentKey,
      ]);
      return toAgentOutput(await q1("SELECT * FROM agent_outputs WHERE case_id = ? AND agent_key = ? LIMIT 1", [caseId, agentKey]));
    },
  },
  notification: {
    async create(args: any) {
      const d = args.data;
      const id = randomUUID();
      await q(
        `INSERT INTO notifications (id,user_id,title,body,read_at,created_at,updated_at) VALUES (?,?,?,?,NULL,NOW(3),NOW(3))`,
        [id, d.userId, d.title, d.body],
      );
      return toNotification(await q1("SELECT * FROM notifications WHERE id = ?", [id]));
    },
    async findMany(args: any) {
      const userId = args.where?.userId;
      const take = args.take ? Number(args.take) : undefined;
      const rows = await q(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC ${take ? `LIMIT ${take}` : ""}`, [userId]);
      return (rows as any[]).map(toNotification);
    },
    async findUnique(args: any) {
      return toNotification(await q1("SELECT * FROM notifications WHERE id = ? LIMIT 1", [args.where.id]));
    },
    async update(args: any) {
      const { sets, values } = sqlSet(args.data, { readAt: "read_at" });
      sets.push("updated_at = NOW(3)");
      await q(`UPDATE notifications SET ${sets.join(", ")} WHERE id = ?`, [...values, args.where.id]);
      return toNotification(await q1("SELECT * FROM notifications WHERE id = ?", [args.where.id]));
    },
  },
};

export { pool as mysqlPool, withTx };
