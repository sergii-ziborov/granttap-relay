# Relay source modules

- `worker.js` routes Cloudflare requests and owns room/pairing Durable Objects.
- `relay/room.js` owns authenticated ciphertext delivery, offline retry, and APNs wake registration.
- `relay/pairingMailbox.js` owns one-use native-device pairing mailboxes.
- `relay/connectionPolicy.js`, `relay/coolDown.js` and `relay/relayLog.js` hold the
  close codes, reconnect cool-down and diagnostic logging shared by both runtimes;
  `relay/roomSockets.js` applies them in the Durable Object.
- `node/server.js` wires the Node service; `node/upgrade-gate.js`,
  `node/socket-messages.js`, `node/socket-policy.js` and `node/heartbeat.js` own
  upgrade refusal, frame routing, policy closes and liveness. See
  [relay/README.md](relay/README.md#connection-policy).

Personal production intentionally has no browser workspace, approval-card,
browser-pairing, or vault modules.

Tests live in `../tests`. New production modules remain below 300 lines.
