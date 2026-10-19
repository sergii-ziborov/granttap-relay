# Bounded socket delivery

`index.js` bounds ciphertext queued by Node for slow receivers. The usual socket
buffer budget is 4 MiB. One legal large frame can enter an empty socket. Across
the relay, send callbacks may hold at most 64 MiB. Close and error paths release
their reservations. No payload is inspected or logged.

A slow receiver closes with WebSocket 1013 and `retry-after=5`. A reliable frame
was already persisted before forwarding, so reconnect replays it until decrypt
ACK. Sender storage receipts do not wait for the receiver or this buffer.

Tests live in `tests/`, with real WebSocket delivery covered by the relay suites.
