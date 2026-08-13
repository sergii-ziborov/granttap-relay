# GrantTap vault (Worker)

Phone-code login + encrypted vault live on the same host as the WSS relay:

- **UI:** `https://granttap-relay.sergii-ziborov.workers.dev/` or `/vault`
- **API:** `GET|PUT|DELETE /api/vault/<vaultId>` — ciphertext only (atomic vault DO, encrypted KV migration mirror)
- **Approvals (unchanged):** `/a/<room>/<viewToken>`
- **Relay (unchanged):** `wss://…/?room=…`

## Login

1. Create a vault in the browser (**Create vault**) or enter an existing **GTW1.** code.
2. The code is 32 random bytes (AES-256-GCM key), shown as `GTW1.<base64url>`.
3. Client derives `vaultId = SHA-256(key material)` and decrypts the envelope locally.
4. Ciphertext may sync to KV under `vaultId`. The unlock code never leaves the device.

Compatible with the Lovable vault (`granttap-vault.lovable.app`) crypto: same GTW1 format and AES-GCM envelope `{ v, iv, ciphertext, createdAt, updatedAt }`.

## Revision safety

- `GET` returns the encrypted envelope plus a 64-hex `revision`, with the same value as a strong `ETag`.
- Create with `If-None-Match: *`.
- Update or delete with the exact `If-Match: "<revision>"` received from `GET`/`PUT`.
- A stale writer receives `412`; a writer without a precondition receives `428`.

The vault-scoped Durable Object serializes CAS; KV contains only an opaque
AES-GCM envelope and is used to migrate pre-CAS data. On conflict, clients fetch
the latest envelope, decrypt locally, replay their semantic add/remove, and retry
a bounded number of times. Unlock codes and plaintext never reach either store.

The approval capability API accepts browser requests only from the relay itself,
local development origins, `https://granttap.com`, `https://www.granttap.com`,
`https://granttap-vault.lovable.app`, and exact origins listed in the
comma-separated Worker variable `GRANTTAP_WEB_ORIGINS`. Decisions
remain visible as “waiting for computer confirmation” until the authenticated
machine consumes and removes the request. The same allowlist protects browser
access to `/api/vault`; that endpoint stores only the bounded AES-GCM envelope.

Approval cards expire, but the unguessable page URL is currently a durable
capability. Keep it private (the web vault stores it encrypted); do not describe
or treat the URL itself as short-lived.

## Phone code (minimal)

iOS can later show the same GTW1 code the Mac/monitor generates. Until then:

- Generate via **Create vault** on the web UI and save the code, or
- Park ciphertext in KV from the Mac monitor using `/api/vault/<vaultId>` once a code exists.

Do not put unlock codes in Worker logs, KV keys, or notify text.
