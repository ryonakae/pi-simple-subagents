import { randomBytes } from "node:crypto";

export function createRunId(): string {
  return `sub_${randomBytes(6).toString("hex")}`;
}
