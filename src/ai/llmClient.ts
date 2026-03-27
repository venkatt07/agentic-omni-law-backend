import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { runtimeMetrics } from "./runtimeMetrics.js";

type GenerateOptions = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  timeoutMs?: number;
  stream?: boolean;
  tier?: "preview" | "final";
  signal?: AbortSignal;
};

type CompletionResponse = {
  content?: string;
  completion?: string;
  text?: string;
  choices?: Array<{ text?: string; content?: string }>;
  timings?: Record<string, unknown>;
  tokens_evaluated?: number;
  tokens_predicted?: number;
  truncated?: boolean;
};

function getActiveContextSize(tier?: GenerateOptions["tier"]) {
  const env = getEnv();
  if (tier === "preview") return env.PREVIEW_GEN_CTX || env.GEN_CTX_COMPACT;
  if (tier === "final") return env.FINAL_GEN_CTX || env.GEN_CTX_QUALITY;
  return env.AI_PROFILE === "quality" ? env.GEN_CTX_QUALITY : env.GEN_CTX_COMPACT;
}

function estimatePromptTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  // Conservative estimate for multilingual legal text.
  return Math.ceil(ascii / 3.2 + nonAscii * 0.95);
}

function fitPromptToContext(prompt: string, requestedOutputTokens: number, tier?: GenerateOptions["tier"]) {
  const nCtx = getActiveContextSize(tier);
  const safetyReserve = 96;
  const outputReserve = Math.max(64, Math.min(requestedOutputTokens, Math.floor(nCtx * 0.35)));
  const maxPromptTokens = Math.max(256, nCtx - outputReserve - safetyReserve);

  const estimated = estimatePromptTokens(prompt);
  if (estimated <= maxPromptTokens) {
    return { prompt, truncated: false, estimatedTokens: estimated, maxPromptTokens };
  }

  // Trim conservatively while preserving the head (instructions/schema) and tail (latest context/query).
  const targetChars = Math.max(900, Math.floor((prompt.length * maxPromptTokens) / Math.max(estimated, 1)));
  const headChars = Math.min(Math.floor(targetChars * 0.55), prompt.length);
  const tailChars = Math.min(Math.floor(targetChars * 0.4), Math.max(0, prompt.length - headChars));
  const head = prompt.slice(0, headChars);
  const tail = prompt.slice(prompt.length - tailChars);
  const compact = `${head}\n\n[CONTEXT_TRUNCATED_FOR_CONTEXT_BUDGET]\n\n${tail}`;
  return {
    prompt: compact,
    truncated: true,
    estimatedTokens: estimatePromptTokens(compact),
    maxPromptTokens,
  };
}

export class LlmRequestError extends Error {
  status?: number;
  bodyText?: string;
  isContextOverflow?: boolean;
  constructor(message: string, opts?: { status?: number; bodyText?: string; isContextOverflow?: boolean }) {
    super(message);
    this.name = "LlmRequestError";
    this.status = opts?.status;
    this.bodyText = opts?.bodyText;
    this.isContextOverflow = opts?.isContextOverflow;
  }
}

function isRetryableLlmError(error: unknown) {
  if (error instanceof LlmRequestError) {
    if (error.isContextOverflow) return false;
    if (typeof error.status === "number" && error.status >= 400 && error.status < 500) return false;
  }
  return true;
}

function detectContextOverflow(bodyText: string) {
  const t = bodyText.toLowerCase();
  return (
    t.includes("exceeds the available context size") ||
    t.includes("context size") && t.includes("exceeds") ||
    t.includes("n_ctx") && t.includes("exceed")
  );
}

function defaultGenerationOptions(partial: GenerateOptions = {}): Required<Pick<GenerateOptions, "temperature" | "top_p" | "max_tokens" | "stop" | "timeoutMs">> {
  const env = getEnv();
  const timeoutFromEnv = Number(env.LLM_REQUEST_TIMEOUT_MS || 0);
  const effectiveTimeoutMs =
    timeoutFromEnv > 0
      ? (partial.timeoutMs ?? timeoutFromEnv)
      : 0;
  const profileMax =
    partial.tier === "preview"
      ? (env.PREVIEW_GEN_MAX_TOKENS || env.GEN_MAX_TOKENS_COMPACT)
      : partial.tier === "final"
        ? (env.FINAL_GEN_MAX_TOKENS || env.GEN_MAX_TOKENS_QUALITY)
        : env.AI_PROFILE === "quality"
          ? env.GEN_MAX_TOKENS_QUALITY
          : env.GEN_MAX_TOKENS_COMPACT;
  return {
    temperature: Math.min(partial.temperature ?? env.GEN_TEMPERATURE, 0.35),
    top_p: Math.min(partial.top_p ?? 0.92, 0.97),
    max_tokens: partial.max_tokens ?? profileMax,
    stop: partial.stop ?? [],
    timeoutMs: effectiveTimeoutMs,
  };
}

function getEndpointForTier(tier?: GenerateOptions["tier"]) {
  const env = getEnv();
  if (tier === "preview") return env.PREVIEW_LLM_ENDPOINT || env.LLM_ENDPOINT;
  if (tier === "final") return env.FINAL_LLM_ENDPOINT || env.LLM_ENDPOINT;
  return env.LLM_ENDPOINT;
}

async function callJsonCompletion(prompt: string, options: GenerateOptions = {}) {
  const final = defaultGenerationOptions(options);
  const endpoint = getEndpointForTier(options.tier);
  const fitted = fitPromptToContext(prompt, final.max_tokens, options.tier);
  const controller = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = () => {
    try {
      controller.abort((externalSignal as any)?.reason);
    } catch {
      controller.abort();
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeout = final.timeoutMs > 0 ? setTimeout(() => controller.abort(), final.timeoutMs) : null;
  const started = Date.now();
  try {
    const res = await fetch(`${endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        prompt: fitted.prompt,
        temperature: final.temperature,
        top_p: final.top_p,
        n_predict: final.max_tokens,
        stop: final.stop,
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new LlmRequestError(`LLM HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`, {
        status: res.status,
        bodyText,
        isContextOverflow: res.status === 400 && detectContextOverflow(bodyText),
      });
    }
    const json = (await res.json()) as CompletionResponse;
    const text = json.content ?? json.completion ?? json.text ?? json.choices?.[0]?.text ?? json.choices?.[0]?.content ?? "";
    const promptTokens = fitted.estimatedTokens;
    const completionTokens = typeof json.tokens_predicted === "number" ? json.tokens_predicted : estimatePromptTokens(text);
    const totalTokens = promptTokens + completionTokens;
    logger.info(
      `[ai.gen] tier=${options.tier || "default"} mode=completion endpoint=${endpoint}/completion prompt_tokens=${promptTokens} completion_tokens=${completionTokens} total_tokens=${totalTokens} latency_ms=${Date.now() - started}${fitted.truncated ? " prompt_truncated=true" : ""}`,
    );
    return text;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    runtimeMetrics.recordAiLatency("/llm/completion", Date.now() - started);
  }
}

async function streamCompletion(
  prompt: string,
  onToken: (token: string) => void | Promise<void>,
  options: GenerateOptions = {},
) {
  const final = defaultGenerationOptions(options);
  const endpoint = getEndpointForTier(options.tier);
  const fitted = fitPromptToContext(prompt, final.max_tokens, options.tier);
  const controller = new AbortController();
  const externalSignal = options.signal;
  const onExternalAbort = () => {
    try {
      controller.abort((externalSignal as any)?.reason);
    } catch {
      controller.abort();
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeout = final.timeoutMs > 0 ? setTimeout(() => controller.abort(), final.timeoutMs) : null;
  const started = Date.now();
  let accumulated = "";
  try {
    const res = await fetch(`${endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        prompt: fitted.prompt,
        temperature: final.temperature,
        top_p: final.top_p,
        n_predict: final.max_tokens,
        stop: final.stop,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const bodyText = await res.text().catch(() => "");
      throw new LlmRequestError(`LLM stream HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`, {
        status: res.status,
        bodyText,
        isContextOverflow: res.status === 400 && detectContextOverflow(bodyText),
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        const payloadLine = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!payloadLine || payloadLine === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payloadLine);
          const token = parsed.content ?? parsed.token ?? parsed.text ?? "";
          if (token) {
            accumulated += token;
            await onToken(token);
          }
        } catch {
          // Some runtimes send plain text chunks; accept as-is.
          accumulated += payloadLine;
          await onToken(payloadLine);
        }
      }
    }
    const promptTokens = fitted.estimatedTokens;
    const completionTokens = estimatePromptTokens(accumulated);
    const totalTokens = promptTokens + completionTokens;
    logger.info(
      `[ai.gen] tier=${options.tier || "default"} mode=stream endpoint=${endpoint}/completion prompt_tokens=${promptTokens} completion_tokens=${completionTokens} total_tokens=${totalTokens} latency_ms=${Date.now() - started}${fitted.truncated ? " prompt_truncated=true" : ""}`,
    );
    return accumulated;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    runtimeMetrics.recordAiLatency("/llm/completion_stream", Date.now() - started);
  }
}

export const llmClient = {
  async generateText(prompt: string, options: GenerateOptions = {}) {
    try {
      return await callJsonCompletion(prompt, options);
    } catch (error) {
      if (!isRetryableLlmError(error)) throw error;
      return await callJsonCompletion(prompt, options);
    }
  },

  async streamText(
    prompt: string,
    onToken: (token: string) => void | Promise<void>,
    options: GenerateOptions = {},
  ) {
    try {
      return await streamCompletion(prompt, onToken, options);
    } catch (error) {
      if (!isRetryableLlmError(error)) throw error;
      const text = await callJsonCompletion(prompt, options).catch(() => callJsonCompletion(prompt, options));
      // Fallback progressive emit in chunks for UX continuity.
      for (const chunk of text.match(/.{1,24}/g) || [text]) {
        await onToken(chunk);
      }
      return text;
    }
  },
};

export function isLlmContextOverflowError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof LlmRequestError) return !!error.isContextOverflow;
  const msg = String((error as any)?.message || error).toLowerCase();
  return msg.includes("context size") && (msg.includes("exceeds") || msg.includes("available context"));
}
