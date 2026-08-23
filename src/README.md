# Relay source modules

- `worker.js` routes Cloudflare requests and owns room/pairing Durable Objects.
- `relay/room.js` owns authenticated ciphertext delivery, offline retry, and APNs wake registration.
- `relay/pairingMailbox.js` owns one-use native-device pairing mailboxes.

Personal production intentionally has no browser workspace, approval-card,
browser-pairing, or vault modules.

Tests live in `../tests`. New production modules remain below 300 lines.
