# Encrypted task Live Activities

`index.js` owns the bounded registration and update contract for GrantTap task
Live Activities. A room credential authorizes every operation. The relay stores
the APNs routing token and an opaque enrollment box; its subscription response
omits the token. Enrollment keys and task previews stay encrypted between the
paired computer and the Apple client. APNs content state contains only a NaCl
nonce and box, with a short stale date. No task text is accepted as HTTP fields.

Registrations expire within eight hours and are limited to eight per room.
Tests live in `tests/`. The repository's GrantTap Commercial Source License applies.
