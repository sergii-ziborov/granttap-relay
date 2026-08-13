# Relay source modules

- `worker.js` routes Cloudflare requests and owns room/pairing Durable Objects.
- `webPairing.js` owns the origin-bound, one-use browser QR exchange. The relay
  stores only the browser origin and ciphertext; the transfer key stays in QR.
- `approvals.js` owns bounded approval-card parsing and its static HTML page.
- `vault*.js` own the encrypted browser-vault primitives.

Tests live in `../tests`. New production modules remain below 300 lines.
