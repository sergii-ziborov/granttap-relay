# Retained encrypted state

Public adapters: `NodeRetainedState` and `WorkerRetainedState`. `policy.js`
validates and bounds replacement snapshots; `socketReplay.js` paces Node replay.
The sender negotiates `retainedState` in `relay.capabilities` before adding opaque
`stateKey`, `stateGroup`, `stateRevision`, and `statePriority` envelope fields. Old clients and
relays retain the existing wire behavior.

Only machine-to-phone, recipient-addressed ciphertext can enter this store.
A newer revision replaces its exact room/recipient/slot. Delivery ACKs never
remove this latest-state copy. On a phone hello the relay sends keys before
catalogs, Mesh snapshots and transcript heads, without requiring a machine to be
online. Each recipient is selected explicitly; legacy connections without a
recipient digest cannot read retained state.

Each room holds at most 512 slots and 16 MiB, each frame at most 1.8 MB, with an
expiry no later than seven days. At capacity, older chat heads are evicted before Mesh snapshots, catalogs and key grants;
read state for recently connected controllers is preferred over dormant recipients. This read cache promises neither a complete archive nor permanent storage.
Node purges expired rows each minute; Worker drops expired rows on replacement
and never replays them. Durable queued commands use the separate task-dispatch
store: cache eviction and decrypt ACKs cannot cancel or execute queued work.

The relay never sees source text, messages, Mesh content or decryption keys.
Revision, priority, room and public-key digests are routing metadata, not proof
of current agent activity. Clients preserve original generation times and
independently authenticate and decrypt every replayed payload.

Tests: `npm test` and `npm run test:coverage` include this module's tests.

Scoped key grants and their encrypted read snapshots share an opaque group and are evicted together. Catalog discovery has independent priority, so historical key grants cannot crowd out the chat list. The Node adapter migrates the earlier unlinked read cache without modifying durable queued work. Worker indexes retain only slot addresses to stay within per-value storage bounds.
