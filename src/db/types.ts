export type UserRole = "LAWYER" | "LAW_STUDENT" | "BUSINESS_CORPORATE" | "NORMAL_PERSON";
export type DocumentKind = "uploaded" | "pasted_text";
export type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export const UserRole = {
  LAWYER: "LAWYER" as UserRole,
  LAW_STUDENT: "LAW_STUDENT" as UserRole,
  BUSINESS_CORPORATE: "BUSINESS_CORPORATE" as UserRole,
  NORMAL_PERSON: "NORMAL_PERSON" as UserRole,
};

export const RunStatus = {
  PENDING: "PENDING" as RunStatus,
  RUNNING: "RUNNING" as RunStatus,
  SUCCEEDED: "SUCCEEDED" as RunStatus,
  FAILED: "FAILED" as RunStatus,
};

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  gender?: string | null;
  dateOfBirth?: Date | null;
  passwordHash: string;
  role: UserRole;
  isVerified: boolean;
  preferredLanguage: string;
  activeCaseId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
