import { createHash } from "node:crypto";

type EventPayload = Record<string, unknown>;
type CanonicalIssue = Readonly<{id: string; identifier: string | null; title: string; status: string}>;

export type StatusDeliveryReceipt = Readonly<{issueId: string; eventId: string; status: "attempted" | "delivered" | "failed"; at: string}>;
export type StatusDeliveryState = Readonly<{contract: "fai.status-deliveries.v1"; receipts: Readonly<Record<string, StatusDeliveryReceipt>>}>;

const empty = (): StatusDeliveryState => ({contract: "fai.status-deliveries.v1", receipts: {}});

export function statusDeliveryKey(issueId: string, eventId: string) {
  if (!/^[A-Za-z0-9-]{1,200}$/.test(issueId) || !/^[A-Za-z0-9-]{1,200}$/.test(eventId)) throw new Error("status_notification_event_invalid");
  return createHash("sha256").update(`${issueId}:${eventId}`).digest("hex");
}

export function parseStatusDeliveryState(value: unknown): StatusDeliveryState {
  if (!value || typeof value !== "object") return empty();
  const candidate = value as {contract?: unknown; receipts?: unknown};
  if (candidate.contract !== "fai.status-deliveries.v1" || !candidate.receipts || typeof candidate.receipts !== "object" || Array.isArray(candidate.receipts)) return empty();
  const receipts: Record<string, StatusDeliveryReceipt> = {};
  for (const [key, raw] of Object.entries(candidate.receipts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !raw || typeof raw !== "object") continue;
    const receipt = raw as Partial<StatusDeliveryReceipt>;
    if (!/^[A-Za-z0-9-]{1,200}$/.test(receipt.issueId ?? "") || !/^[A-Za-z0-9-]{1,200}$/.test(receipt.eventId ?? "") ||
        !["attempted", "delivered", "failed"].includes(receipt.status ?? "") || typeof receipt.at !== "string") continue;
    receipts[key] = receipt as StatusDeliveryReceipt;
  }
  return {contract: "fai.status-deliveries.v1", receipts};
}

export function recordStatusDelivery(state: StatusDeliveryState, key: string, receipt: StatusDeliveryReceipt): StatusDeliveryState {
  const entries = Object.entries({...state.receipts, [key]: receipt}).sort(([, left], [, right]) => right.at.localeCompare(left.at)).slice(0, 128);
  return {contract: "fai.status-deliveries.v1", receipts: Object.fromEntries(entries)};
}

export function canonicalStatusTransition(payload: unknown, issue: CanonicalIssue | null): string | null {
  if (!payload || typeof payload !== "object" || !issue) return null;
  const value = payload as EventPayload;
  const prior = value._previous;
  const previousStatus = prior && typeof prior === "object" ? (prior as EventPayload).status : null;
  const patch = value.patch;
  const changedStatus = typeof value.status === "string" ? value.status
    : patch && typeof patch === "object" ? (patch as EventPayload).status : null;
  if (typeof changedStatus !== "string" || typeof previousStatus !== "string" || changedStatus === previousStatus || issue.status !== changedStatus) return null;
  return changedStatus;
}

const text = (value: string, maximum: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);

export function statusNotificationMessage(issue: CanonicalIssue): string {
  const ref = text(issue.identifier || issue.id, 200);
  const title = text(issue.title, 360) || "Untitled issue";
  const status = text(issue.status, 80);
  return `f(AI) Control: ${ref} → ${status}\n${title}\nhttps://app.f-ai.studio/issues/${encodeURIComponent(issue.id)}`.slice(0, 1_000);
}
