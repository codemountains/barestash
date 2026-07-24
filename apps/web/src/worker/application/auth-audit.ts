import {
  type AuthAuditRecord,
  formatAuthAuditRecord,
} from "@barestash/shared/auth-audit";

/** @public */
export function logAuthAudit(record: AuthAuditRecord): void {
  console.log(formatAuthAuditRecord(record));
}
