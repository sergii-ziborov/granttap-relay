# Durable encrypted task dispatch

Public HTTP entry: `taskDispatchResponse` in `index.js`. Node SQLite adapter:
`NodeTaskDispatchStore` in `node.js`. Worker adapter: `WorkerTaskDispatchStore` in
`worker.js`. `worker-room.js` composes scheduling alarms with endpoint expiry;
`socket-offers.js` sends eligible ciphertext to a connected recipient.

This is a transport API. Clients must implement the encrypted task body,
durable receiver admission and provider delivery; an ordinary decrypt ACK does
not claim a task job.

## API

All routes use the existing room bearer credential. They do not pin a new room.

- `PUT /task-jobs/:id?room=…`: immutable encrypted envelope, `notBefore`,
  `expiresAt`, and SHA-256 `acceptanceHash`. Returns a durable queued receipt.
  Identical retry returns the existing receipt; conflicting content returns 409.
- `GET /task-jobs?room=…`: unresolved queued, accepted and failed job metadata (no ciphertext).
- `GET /task-jobs/:id?room=…`: one encrypted job for recovery; add `metadata=1` for a small reconciliation receipt.
- `POST /task-jobs/:id/claim?room=…`: receiver supplies `token` and its public-key
  digest and a stable receiver `claimId` after durably storing the authenticated job. The token travels inside
  the encrypted body; only its hash is stored by the relay. Future, expired,
  cancelled or already finished jobs cannot start.
- `POST /task-jobs/:id/finish?room=…`: the same proof and claim id plus `completed` or `failed`. A different claim id cannot claim or finish an accepted job.
  Completed means the message was delivered, not that the coding Task is finished.
  Failure details are bounded result codes, never prompt or provider output.
- `DELETE /task-jobs/:id?room=…`: cancel pending or failed work. An accepted job
  has left the relay queue; use the computer's existing task stop action.

A machine advertises `X-GrantTap-Task-Dispatch: 1` and its recipient key digest.
After its authenticated hello registers the machine role, Node's pump or the
Worker alarm offers `{type: "relay.task-job", job}` when due. Offers repeat
until a receiver claims the job. The machine must independently verify that
signed scheduling, recipient and job identity match before claiming or running.
A scheduled job can therefore remain on the relay while its phone is off.

## Bounds and retention

At most 100 unresolved jobs and 48 MB of pending ciphertext per room; one job is
at most 22 MB including metadata. Worker storage splits ciphertext into checksummed
64 KiB chunks, so complete inline photo batches also survive offline delivery. Scheduling and delivery expiry are bounded to
30 days. Oversized/full queues reject new work and never evict promised jobs.
Messages must include their required attachments in the encrypted job, rather
than depend on transient upload references.

Completed, cancelled and expired jobs discard ciphertext while retaining
idempotency receipts. Those receipts do not occupy pending capacity. Receipt
history is separately bounded to 10,000 rows and purged after expiry plus seven
days. An accepted job remains tracked until the receiver confirms its outcome;
the relay never guesses that execution stopped because a connection disappeared.

Tests: `npm test` includes local module tests. `npm run test:coverage` verifies
Node HTTP/WebSocket replay after restart, phone-independent scheduled delivery,
receiver proof, cancellation races, Worker storage/alarms and capacity bounds.
