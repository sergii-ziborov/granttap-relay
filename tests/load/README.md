# Relay load and restart check

Run `node tests/load/relay-load.mjs` with Node 22+; `LOAD_ACCOUNTS` accepts 1–100.
The default checks 20 accounts, two rooms each, 15 computers and two controllers
per room: 680 simultaneously connected WebSockets after restart. All rooms,
credentials, managed admission keys and ciphertext are synthetic and ephemeral.

The test first persists submissions with the target computers disconnected,
then restarts the real Node relay on the same SQLite database, reconnects the
computers and confirms replay and transport-ACK cleanup. It then sends a mixture
of 4 KiB and 64 KiB opaque frames and measures storage receipts, deliveries,
server RSS, event loop latency and durable write counts.

This is a transport test. The four offline submissions model independent agent
messages but do not invoke providers. It measures no Apple push or TLS overhead
and is not a capacity claim for a different server. No production endpoint is
contacted. Temporary state is removed on completion.
