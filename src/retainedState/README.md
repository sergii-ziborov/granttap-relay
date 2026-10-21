# Retained encrypted state

Public adapters: `NodeRetainedState` and `WorkerRetainedState`. `policy.js`
validates and bounds replacement snapshots; `socketReplay.js` paces Node replay.
The sender negotiates `retainedState` in `relay.capabilities` before adding opaque
`stateKey`, `stateRevision`, and `statePriority` envelope fields. Old clients and
relays retain the existing wire behavior.

Only machine-to-phone, recipient-addressed ciphertext can enter this store.
A newer revision replaces its exact room/recipient/slot. Delivery ACKs never
remove this latest-state copy. On a phone hello the relay sends keys before
catalogs, Mesh snapshots and transcript heads, without requiring a machine to be
online. Each recipient is selected explicitly; legacy connections without a
recipient digest cannot read retained state.

Each room holds at most 512 slots and 8 MiB, each frame at most 1.8 MB, with an
expiry no later than seven days. The oldest snapshots may be evicted at capacity;
this read cache promises neither a complete archive nor permanent storage.
Node purges expired rows each minute; Worker drops expired rows on replacement
and never replays them. Durable queued commands use the separate task-dispatch
store: cache eviction and decrypt ACKs cannot cancel or execute queued work.

The relay never sees source text, messages, Mesh content or decryption keys.
Revision, priority, room and public-key digests are routing metadata, not proof
of current agent activity. Clients preserve original generation times and
independently authenticate and decrypt every replayed payload.

Tests: `npm test` and `npm run test:coverage` include this module's tests.
