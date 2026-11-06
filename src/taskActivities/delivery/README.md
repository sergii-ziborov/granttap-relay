# Encrypted activity delivery

`index.js` owns authenticated HTTP registration, subscription reads and delivery
of encrypted task snapshots. Receipts make retries idempotent. Replaceable updates
are coalesced; an explicit end dismisses the activity promptly. Private APNs routes
stay inside the registry and provider errors never echo tokens or enrollment data.

Tests live in `tests/`. The repository GrantTap Commercial Source License applies.
