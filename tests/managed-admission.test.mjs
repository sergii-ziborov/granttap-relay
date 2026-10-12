import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedAdmission, readManagedTicket } from "../src/node/managed-admission.js";

const secret = Buffer.alloc(32, 7);
const claim = { version: 1, accountId: "12345678-1234-4123-8123-123456789012",
  computerId: "22345678-1234-4123-8123-123456789012", publicKey: Buffer.alloc(32, 3).toString("base64"),
  room: "room-commercial", expiresAt: 100_000 };
function signed(value = claim, key = secret) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(`granttap-managed-v1.${body}`).digest("base64url")}`;
}

test("managed tickets are authenticated, room-bound, short-lived and fail closed", () => {
  assert.deepEqual(readManagedTicket(signed(), secret, claim.room, 1_000), claim);
  for (const token of ["bad", signed(claim, Buffer.alloc(32, 4)), signed({ ...claim, version: 2 }),
    signed({ ...claim, publicKey: "bad" }), signed({ ...claim, accountId: "other" }),
    signed({ ...claim, expiresAt: 999 }), signed({ ...claim, expiresAt: 1_000_000 })]) {
    assert.equal(readManagedTicket(token, secret, claim.room, 1_000), null);
  }
  assert.equal(readManagedTicket(signed(), secret, "other-room", 1_000), null);
  assert.equal(readManagedTicket(signed(), secret, claim.room, 100_000), null);
});

test("self-hosted mode has no paid admission and commercial mode requires a signing key", () => {
  assert.equal(managedAdmission({}), null);
  assert.throws(() => managedAdmission({ MANAGED_ADMISSION_REQUIRED: "1" }), /key/i);
  const dir = mkdtempSync(join(tmpdir(), "granttap-admission-"));
  const path = join(dir, "key");
  writeFileSync(path, secret, { mode: 0o600 });
  const verify = managedAdmission({ MANAGED_ADMISSION_REQUIRED: "1", MANAGED_ADMISSION_KEY_PATH: path });
  const fresh = { ...claim, expiresAt: Date.now() + 60_000 };
  assert.deepEqual(verify(signed(fresh), claim.room), fresh);
});
