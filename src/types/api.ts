export type RunStepState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface RunStep {
  name: string;
  state: RunStepState;
  progress: number;
  message?: string;
}

export interface Citation {
  ref?: string;
  doc_id: string;
  title?: string | null;
  chunk_id: string;
  page?: number | null;
  offset_start?: number | null;
  offset_end?: number | null;
  snippet: string;
  source_type?: string;
  source_label?: string;
}

export interface CaseSummaryDto {
  case_id: string;
  title: string;
  domain: string;
  updated_at: string;
  last_run_status: string | null;
  run_count?: number;
  successful_run_count?: number;
  query_parsing_rejected?: boolean;
}

export interface CaseDocumentDto {
  doc_id: string;
  name: string;
  type: string;
  size: number;
  created_at: string;
}
