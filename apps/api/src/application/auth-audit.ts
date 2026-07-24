import {
  type AuthAuditRecord,
  formatAuthAuditRecord,
} from "@barestash/shared/auth-audit";

export function logAuthAudit(record: AuthAuditRecord): void {
  console.log(formatAuthAuditRecord(record));
}
