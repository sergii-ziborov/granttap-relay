# Node push delivery

`http2.js` sends APNs requests using Node's TLS HTTP/2 client. The allowed origins
are Apple's sandbox and production endpoints; certificate verification remains
enabled. Requests have an eight-second deadline and bounded response bodies.
No device token, signing key, authorization token or notification content is
written to logs. The shared worker sender retains its fetch transport.

`tests/apnsNodeTransport.test.mjs` exercises a real local HTTP/2 stream through
an injected session factory and verifies Apple's error response semantics.

Node operators can mount private `.p8` files and set `APNS_PRIVATE_KEY_PATH` and
`APNS_SANDBOX_PRIVATE_KEY_PATH`. Set `APNS_TEAM_ID`, `APNS_KEY_ID` and
`APNS_KEY_ENVIRONMENT=production` for the production topic-specific key;
`APNS_SANDBOX_KEY_ID` identifies the sandbox key, with an optional separate
`APNS_SANDBOX_TEAM_ID`. The loader reads the mounts into the server's private
runtime environment without modifying `process.env`. Existing secret-backed
`APNS_PRIVATE_KEY` configuration remains supported.

New Apple keys belong to one environment. Registration reports whether that
particular environment is configured; it does not claim notification delivery.

The shared [wake policy](../../relay/README.md#background-wake-delivery) sends only
silent synchronization hints, persists deduplication/coalescing/retry state in
the additive `relay_wakes` SQLite table, and never removes a reliable envelope
on APNs acceptance. Older relay binaries ignore this additional table, so a
container rollback can reuse the same data file without restoring an older
database snapshot. Pending wake work resumes on startup; a send failure cannot
create an unlimited reminder loop.
