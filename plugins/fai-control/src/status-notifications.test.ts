import { describe, expect, it } from "vitest";
import { canonicalStatusTransition, parseStatusDeliveryState, recordStatusDelivery, statusDeliveryKey, statusNotificationMessage } from "./status-notifications.js";

const issue = {id: "issue-1", identifier: "FAI-7", title: "  Ship\n status update ", status: "in_review"};

describe("native status notifications", () => {
  it("accepts only an event whose changed status still matches the canonical issue", () => {
    expect(canonicalStatusTransition({status: "in_review", _previous: {status: "in_progress"}}, issue)).toBe("in_review");
    expect(canonicalStatusTransition({patch: {status: "in_review"}, _previous: {status: "in_progress"}}, issue)).toBe("in_review");
    expect(canonicalStatusTransition({status: "done", _previous: {status: "in_review"}}, issue)).toBeNull();
  });

  it("ignores a non-status patch", () => {
    expect(canonicalStatusTransition({title: "Edited", _previous: {title: "Before"}}, issue)).toBeNull();
    expect(canonicalStatusTransition({status: "in_review", _previous: {status: "in_review"}}, issue)).toBeNull();
  });

  it("uses a bounded safe message with the native issue path", () => {
    const message = statusNotificationMessage({...issue, title: "x\u0000y"});
    expect(message).toContain("FAI-7 → in_review");
    expect(message).toContain("f(AI) Control: FAI-7");
    expect(message).toContain("https://app.f-ai.studio/issues/issue-1");
    expect(message).not.toContain("\u0000");
    expect(message.length).toBeLessThanOrEqual(1_000);
  });

  it("suppresses only a previously delivered event and retains a failed attempt for retry", () => {
    const key = statusDeliveryKey(issue.id, "event-1");
    const attempted = recordStatusDelivery(parseStatusDeliveryState(null), key, {issueId: issue.id, eventId: "event-1", status: "attempted", at: "2026-09-20T00:00:00.000Z"});
    const failed = recordStatusDelivery(attempted, key, {issueId: issue.id, eventId: "event-1", status: "failed", at: "2026-09-20T00:00:01.000Z"});
    const delivered = recordStatusDelivery(failed, key, {issueId: issue.id, eventId: "event-1", status: "delivered", at: "2026-09-20T00:00:02.000Z"});
    expect(failed.receipts[key]?.status).not.toBe("delivered");
    expect(delivered.receipts[key]?.status).toBe("delivered");
  });
});
