# Relay transport modules

This module owns the public Worker request router, room Durable Object, opaque
envelope delivery, APNs wake delivery, and pairing-mailbox parking.  The relay
only validates bounded routing metadata and never decrypts payloads. Browser
approval and vault routes are absent from the Personal worker.

`../worker.js` is the Cloudflare entry point and intentionally re-exports the
public Durable Object classes and validation helpers for deployment bindings.

The [task dispatch API](../taskDispatch/README.md) holds encrypted scheduled task
jobs independently of transport ACKs and composes its deadlines with endpoint
retention. No task content is decrypted by either relay backend.

## Connection policy

`connectionPolicy.js` (close codes, queue results, per-socket frame rate),
`coolDown.js` (reconnect cool-down) and `relayLog.js` (diagnostic lines) are
shared by both runtimes. Node wires them in `../node/socket-messages.js`,
`../node/socket-policy.js`, `../node/upgrade-gate.js` and `../node/heartbeat.js`;
the Durable Object wires them in `roomSockets.js`.

### Close codes

A close reason is a stable token, optionally followed by `; retry-after=<s>`
when a cool-down was recorded. Reasons never contain identifiers or ciphertext.

| Code | Reason token | When | Cool-down |
| --- | --- | --- | --- |
| 4401 | `admission-expired` | An admitted computer's lease ran out without renewal (Node, managed mode) | yes, cleared by a valid lease |
| 4403 | `admission-required` | A `machine` frame from a socket without a valid managed lease | yes, cleared by a valid lease |
| 4406 | `hub-admission-required` | The same, when the sender id has the iPhone hub's `hub-` prefix | yes, cleared by a valid lease |
| 4409 | `admission-renewal-rejected` | `relay.admission` renewal was invalid, older, for another identity, or from a phone | yes, cleared by a valid lease |
| 4425 | `cool-down` | First frame of a socket whose identity is still cooling down (see below) | no new strike |
| 4429 | `rate-limit` | More than 300 frames in one second on one socket | yes |
| 1009 | `oversize` | A reliable frame above the 1.8 MB retry budget (larger than 32 MiB is refused by the WebSocket layer) | yes |

Managed admission exists only in the Node runtime, so 4401/4403/4406/4409 never
come from the Worker. The 4425, 4429 and 1009 rules are identical in both.

Reliable frames that are already expired, or whose room row is missing (Node),
are dropped: they are neither stored nor forwarded, the socket stays open, and
a client that negotiated relay control frames (`X-GrantTap-Recipient-Routing: 1`)
receives `{"type":"relay.dropped","deliveryId":"…","reason":"expired"|"no-room"}`
echoing its own delivery id. Other clients ignore unknown `relay.*` frames, and
earlier clients get no notice. A full mailbox still evicts its oldest rows; it
never closes the sender.

### Reconnect cool-down

Every close above except `cool-down` records a strike for the socket's
identity. The backoff is 5 s, doubling per strike up to 5 minutes, and strikes
are forgotten after 15 quiet minutes. During the window:

- an upgrade carrying the same `X-GrantTap-Recipient-Key-Id` in the same room is
  refused with `429 Too Many Requests`, `Retry-After: <s>` and
  `{"error":"cool-down","retryAfter":<s>}`, before any WebSocket is created;
- a socket that sent no key digest cannot be identified before it speaks, so its
  first frame is matched by role and a digest of its sender id and closed with 4425.

Other identities in the same room are unaffected. An upgrade or socket that
presents a valid managed lease clears a cool-down caused only by admission
closes, so a renewed computer reconnects immediately. Refused attempts never
extend the window. Keys hold only a 16-hex room prefix plus a 32-hex public-key
digest prefix, or role plus a 64-bit FNV digest of the sender id; tokens,
tickets and ciphertext are never stored. Node keeps at most 10,000 entries and
each Durable Object room at most 256, evicting the least recently struck.
Durable Object cool-downs reset when the room hibernates. Key digests are not
credentials, so a holder of the room credential could provoke a cool-down for
another member's digest; that adds nothing to what the credential already
allows (for example filling the room's 32 sockets).

### Liveness

Node pings every socket every 30 s and terminates a socket that sent no pong,
ping or frame during the following interval, so a dead or half-open peer frees
its `MAX_ROOM_SOCKETS` (32) slot within about a minute. The pings also keep a
healthy idle socket inside nginx `proxy_read_timeout 300s`. `RELAY_HEARTBEAT_MS`
overrides the interval within 1–120 s; `0` disables the heartbeat. Workers cannot
ping hibernatable sockets, so the Durable Object relies on the Cloudflare edge to
close dead peers and has no fixed socket cap.

### Diagnostics

Both runtimes write one JSON line per event to stdout (Node) or the Workers log
(`console.log`): `relay.upgrade_refused` (HTTP status and reason, including
`unauthorized`, `admission-invalid`, `recipient-invalid`, `cool-down` and
`room-full`), `relay.policy_close` (close code, reason and `retryAfter`),
`relay.message_dropped` and `relay.socket_terminated` (`heartbeat-timeout`).
Fields are allowlisted: an 8-hex room prefix, role, code or status, reason
token, retry delay and a `suppressed` count. Each event/room/role/reason key is
written at most once per 10 s and all lines are capped at 50 per second, so a
reconnect storm cannot flood the disk. Tokens, keys, sender ids, envelopes and
IP addresses are never logged; nginx keeps its own access policy.

### Phone hub links in managed mode (open decision)

The iPhone acts as the hub of a shared-project member link by opening a second
pairing with `role: "machine"` (sender id `hub-…`) in a room it created for the
member's invite. That socket has no computer lease, so a managed relay rejects
it. The relay cannot tell a phone hub from a computer: the room, role, sender
id and every header are chosen by the client, and the payload is ciphertext.
Exempting `hub-` senders, a hub header or any room heuristic would let an unpaid
computer claim to be a hub and bypass managed admission.

The relay therefore keeps admission strict: a hub `machine` socket without a
lease is rejected once with 4406 `hub-admission-required` (the `hub-` prefix
only selects the reason and grants nothing) and its key is then cooled down
with 429 + `Retry-After`. The owner decides how hubs become admissible:

1. **Hub lease (no relay change).** The account authority issues the owner's
   phone a normal v1 managed lease bound to the member room and the hub's public
   key; the phone sends it as `X-GrantTap-Admission` and renews it with
   `relay.admission`. Whether such a lease uses a computer seat is a billing
   decision for the authority.
2. **Phone-role hub links.** The hub connects as `phone` and addresses the member
   with recipient routing. No relay change is needed, but member and hub builds
   must both change, and an official app would then accept an unadmitted peer
   that presents a hub invite, which shifts enforcement to the app.
3. **Unmanaged rooms for member links.** Not supported: the relay cannot verify
   that a room belongs to a member link.

Until a choice ships, the iOS app should stop retrying a link closed with
4403/4406 (or refused with 429) for at least `Retry-After`, and surface the
link as needing hub admission instead of reconnecting immediately.
