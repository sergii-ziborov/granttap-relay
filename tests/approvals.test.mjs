import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDecision,
  approvalsPageHtml,
  normalizeDanger,
  parseApprovalCard,
  pruneApprovals,
  publicCard,
  upsertApproval,
  validViewToken,
  validRequestId,
} from "../src/approvals.js";

test("danger normalization and card parse", () => {
  assert.equal(normalizeDanger("destructive"), "destructive");
  assert.equal(normalizeDanger("nope"), "caution");
  assert.equal(normalizeDanger(null), "caution");
  assert.equal(validViewToken("ab".repeat(32)), true);
  assert.equal(validViewToken("short"), false);
  const parsed = parseApprovalCard({
    requestId: "req-1", title: "Allow shell", command: "rm -rf /tmp/x",
    danger: "destructive", agent: "cursor", cwd: "/tmp", tool: "Shell",
    sessionId: "sess", batchId: "batch", ttlMs: 30_000, createdAt: 123,
  });
  assert.equal(parsed.card.danger, "destructive");
  assert.equal(parsed.card.status, "pending");
  assert.equal(parsed.card.cwd, "/tmp");
  assert.equal(parseApprovalCard({}).error, "valid requestId required");
  assert.equal(parseApprovalCard(null).error, "JSON body required");
  assert.equal(parseApprovalCard({ requestId: "req-2", title: "" }).error, "title required (≤800 chars)");
  const clamped = parseApprovalCard({ requestId: "req-3", title: "ok", ttlMs: 999_999_999 });
  assert.ok(clamped.card.expiresAt - Date.now() <= 60 * 60 * 1000 + 50);
});

test("upsert prune and decide", () => {
  const now = Date.now();
  let items = upsertApproval([], { requestId: "a", danger: "safe", title: "t", agent: "cursor", createdAt: now, expiresAt: now + 60_000, status: "pending" }, now);
  items = upsertApproval(items, { requestId: "a", danger: "caution", title: "t2", agent: "cursor", createdAt: now, expiresAt: now + 60_000, status: "pending" }, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].danger, "caution");
  const decided = applyDecision(items, "a", "allow", "web", now);
  assert.equal(decided.found, true);
  assert.equal(decided.items[0].status, "allow");
  assert.equal(publicCard(decided.items[0]).decidedBy, "web");
  assert.equal(publicCard({ ...decided.items[0], command: null, cwd: null }).command, null);
  assert.equal(pruneApprovals([{ requestId: "old", expiresAt: now - 1 }], now).length, 0);
  assert.equal(pruneApprovals(null, now).length, 0);
  assert.equal(pruneApprovals([null, { requestId: "x", expiresAt: now + 1 }], now).length, 1);
  assert.equal(applyDecision(items, "missing", "deny", "web", now).found, false);
  assert.equal(applyDecision([{ requestId: "a", status: "allow", expiresAt: now + 1 }], "a", "deny", "web", now).found, false);
});

test("approvals page html is a visible Allow surface", () => {
  const html = approvalsPageHtml("ab".repeat(16), "cd".repeat(32));
  assert.match(html, /GrantTap Approvals/);
  assert.match(html, /Accept/);
  assert.match(html, /Decline/);
  assert.match(html, /not a chat message/i);
  assert.match(html, /waiting for computer confirmation/i);
  assert.doesNotMatch(html, /st\.textContent=decision==="allow"\?"Accepted"/);
});

test("approval card bounds optional metadata and expiry consistently", () => {
  const now = 1_000;
  assert.equal(validRequestId("req"), false);
  assert.equal(validRequestId("req-1"), true);
  const parsed = parseApprovalCard({ requestId: "req-5", title: "ok", ttlMs: 1, command: undefined, createdAt: "not-a-number" }, now);
  assert.equal(parsed.card.command, null);
  assert.equal(parsed.card.expiresAt, now + 5_000);
  assert.equal(parsed.card.createdAt, now);
  assert.equal(parseApprovalCard({ requestId: "req-6", title: "x".repeat(801) }).error, "title required (≤800 chars)");
  const items = Array.from({ length: 30 }, (_, index) => ({ requestId: String(index), expiresAt: now + 1 }));
  assert.equal(pruneApprovals(items, now).length, 24);
});
