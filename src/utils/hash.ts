import { createHash } from "node:crypto";
export const sha256 = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
