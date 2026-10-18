# Explicit submission receipts

`submissionReceipts.js` owns protected retention and the `relay.stored` response.
Clients opt in to relay control frames with `X-GrantTap-Recipient-Routing: 1`.
An authenticated phone receives a storage receipt only after a successful durable
queue write (or an existing delivery with the same immutable ID).

`user-message-`, `approval-decision-` and `attachment-` delivery IDs protect
explicit submissions from eviction by transient snapshots. Existing queue count,
byte and expiry limits remain enforced. If protected work fills the queue, a new
submission receives `relay.dropped` with `reason: full`; previously accepted work
is retained. A storage receipt never claims native execution or approval.

The provider computer may be offline throughout submission. It receives the
ciphertext when it reconnects, even after the phone disconnected. Only its
authenticated decrypt acknowledgement or the envelope expiry removes the row.
The Node store uses SQLite WAL with synchronous FULL; the Worker awaits Durable
Object storage before emitting its receipt.

Tests: `tests/relaySubmissionReceipts.test.mjs`, plus Node/Worker queue bounds.
