# GrantTap Relay

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The public zero-knowledge relay used by [GrantTap](https://granttap.com).
It runs on Cloudflare Workers with Durable Objects, routes WebSockets by room,
and temporarily queues encrypted envelopes while a paired device is offline.

Production health endpoint:
[granttap-relay.sergii-ziborov.workers.dev/health](https://granttap-relay.sergii-ziborov.workers.dev/health)

## What the relay can and cannot see

The relay can see routing metadata: room, sender/recipient roles, IP addresses,
timing, expiry, and message sizes. It receives `nonce` and `box` as opaque
ciphertext.

The relay cannot decrypt commands, questions, agent messages, user replies, or
approval decisions. Device secret keys are created locally and never sent to
this worker. Short-code pairing blobs are encrypted before upload, expire
after 15 minutes, are single-use, and are rate-limited per source.

The complete production worker is intentionally small and public so this
boundary can be audited instead of trusted as a marketing claim.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness check |
| `wss://host/?room=<room>` | Hibernating WebSocket for one pairing room |
| `PUT /pair/<CODE>` | Park an already encrypted short-code pairing blob |
| `GET /pair/<CODE>` | Consume that blob once |

Queued messages are capped per recipient and expired before delivery.

## Run locally

Requires Node.js 20 or newer.

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

No application secret is required. After deployment, use the emitted secure
WebSocket URL as the relay URL in your GrantTap pairing.

The checked-in `wrangler.toml` uses the worker name `granttap-relay`. Change
the name if that worker name already exists in your account. If you alter
Durable Object class names, add a new migration instead of rewriting the
existing `v1` migration.

## Related

- MCP bridge: [sergii-ziborov/granttap-mcp](https://github.com/sergii-ziborov/granttap-mcp)
- Product: [granttap.com](https://granttap.com)

GrantTap is not affiliated with Anthropic, OpenAI, Apple, or Cloudflare.
