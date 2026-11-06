# Ingress flow

`index.js` defines the optional `X-GrantTap-Ingress-Flow: 1` negotiation.
The relay advertises `ingressWindow: 64` and emits a cumulative `relay.ingress`
read receipt every 16 JSON frames. Managed admission renewal frames use their
separate control lane and are excluded from this counter. Worker attachments
preserve the counter across hibernation.

A supporting sender keeps at most 64 unacknowledged frames while retaining its
normal pacing. A delayed TCP read can then release only a bounded burst, rather
than several seconds of individually paced frames that trip the unchanged
300-frame-per-second abuse limit. Old clients and relays remain compatible.

Read receipts carry no payload, recipient, key or message identifier. They do not
prove decryption, persistence, approval, execution or task delivery. Existing
durable acknowledgements and security limits retain their separate semantics.
