# GrantTap Relay

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The public zero-knowledge relay used by [GrantTap](https://granttap.com).
It runs on Cloudflare Workers with Durable Objects, routes WebSockets by room,
and temporarily queues encrypted envelopes while a paired device is offline.

Production health endpoint:
[granttap-relay.sergii-ziborov.workers.dev/health](https://granttap-relay.sergii-ziborov.workers.dev/health)

| Sessions on iPhone | Visible activity on Apple Watch |
| --- | --- |
| ![GrantTap sessions on iPhone](docs/images/phone-sessions.png) | ![GrantTap activity on Apple Watch](docs/images/watch-activity.png) |

## What the relay can and cannot see

The relay can see routing metadata: room, sender/recipient roles, IP addresses,
timing, expiry, message sizes, and—when background delivery is enabled—an APNs
device token plus its sandbox/production environment. It receives `nonce` and
`box` as opaque ciphertext. Silent push wakes contain no command, prompt, path,
session title, or message text.

The relay cannot decrypt commands, questions, agent messages, user replies, or
approval decisions. Device and per-task secret keys are created locally and
never sent to this worker. Pairing hand-off uses a random 128-bit mailbox id
that is independent from the 256-bit transfer key kept in the QR/manual token.
The worker receives the mailbox and ciphertext, but never the transfer key.
Mailboxes expire after 15 minutes and are single-use.

Plaintext exists only on authorized endpoints. Traffic crossing the app
transport, network, Cloudflare, Durable Objects, and APNs remains authenticated
ciphertext. One task key cannot decrypt a second task; a device can open that
second task only if its independent key was explicitly granted to that device.

The complete production worker is intentionally small and public so this
boundary can be audited instead of trusted as a marketing claim.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness check |
| `wss://host/?room=<room>` | Hibernating WebSocket for one pairing room |
| `PUT /pair/<MAILBOX_ID>` | Park an already encrypted pairing blob; no key is sent |
| `GET /pair/<MAILBOX_ID>` | Consume that ciphertext once |
| `PUT /push/register?room=<room>` | Register an APNs token with the room credential |
| `DELETE /push/register?room=<room>` | Remove that APNs token |
| `GET /push/status?room=<room>` | Report provider configuration and registered device count |

Queued messages are capped per recipient, by total stored bytes, and expired before delivery. New
clients attach an opaque delivery id; the relay retains that ciphertext until
the receiving client confirms that it decrypted the envelope. The queue does
not treat a WebSocket write as proof of delivery. Cloudflare limits one
Durable Object key/value to 2 MB, so encrypted frames above the relay's 1.8 MB
retry budget are delivered only to an already connected peer and are not stored
for offline retry. Client attachment limits keep complete task frames under the
separate 32 MiB WebSocket receive limit.

The APNs payload is a silent background wake with `content-available: 1` and
`granttapWake: true`: no alert, sound, task kind, request id, delivery id,
prompt, command, title, or path. It asks iOS to pull and decrypt the queued E2EE
envelope, after which the app creates one actionable local notification. Apple
does not guarantee background execution timing, so this is best-effort—not a
promise of instant delivery.

A Cloudflare account takeover or Durable Object database export therefore
reveals only ciphertext plus operational metadata (opaque room/mailbox ids,
routing roles, IPs, timing/expiry, sizes, APNs token/environment, and the
neutral wake flag). There is no decryption key in Worker code, bindings,
storage, logs, or encrypted Worker secrets. APNs provider credentials can sign
notifications but cannot decrypt GrantTap traffic.

## Run locally

Requires Node.js 22 or newer (the minimum supported by the pinned Wrangler line).

```bash
git clone https://github.com/sergii-ziborov/granttap-relay.git
cd granttap-relay
npm install
npm test
npm run dev
```

Wrangler uses the same Workers runtime locally, including the Durable Object
bindings declared in `wrangler.toml`.

## Deploy to your Cloudflare account

```bash
npx wrangler login
npm run deploy
```

WebSocket relay and offline queues work without application secrets. Background
APNs delivery requires an Apple Push Notification authentication key. Store the
following as encrypted Cloudflare Worker secrets:

```bash
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_PRIVATE_KEY
```

`APNS_PRIVATE_KEY` is the complete `.p8` content. After deployment, use the
emitted secure WebSocket URL as the relay URL in your GrantTap pairing. Without
all three secrets, `/push/status` honestly reports `enabled: false`; foreground
WebSocket delivery and durable queues keep working.

Every WebSocket and push endpoint also requires the pairing's random 256-bit
room credential. First use pins only its SHA-256 digest inside that room's
Durable Object; legacy pairings that predate this credential must re-pair.

Never put APNs credentials in `wrangler.toml`, `.env`, a GitHub Actions
variable, or a committed `.dev.vars` file.

For local development, copy `.dev.vars.example` to `.dev.vars`. Git ignores
`.dev.vars`, every `.env*` file except the empty example, private keys,
certificates, and common credential files.

GitHub secret scanning and push protection are enabled for this repository.
Report a suspected leak privately through the repository's
[Security advisories](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new)
instead of opening a public issue.

The checked-in `wrangler.toml` uses the worker name `granttap-relay`. Change
the name if that worker name already exists in your account. If you alter
Durable Object class names, add a new migration instead of rewriting the
existing `v1` migration.

## Related

- MCP bridge: [sergii-ziborov/granttap-mcp](https://github.com/sergii-ziborov/granttap-mcp)
- npm package: [granttap-mcp](https://www.npmjs.com/package/granttap-mcp)
- Product: [granttap.com](https://granttap.com)
- Privacy: [granttap.com/privacy](https://granttap.com/privacy)
- Support: [granttap.com/support](https://granttap.com/support)
- Security policy: [SECURITY.md](SECURITY.md)

GrantTap is not affiliated with Anthropic, OpenAI, Apple, or Cloudflare.
