# Security policy

## Reporting a vulnerability

Please use GitHub's private
[security advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
Do not open a public issue for suspected vulnerabilities, leaked credentials,
or techniques that could affect a running relay.

Include the affected endpoint or commit, expected impact, and a minimal
reproduction when possible. Do not include real GrantTap payloads, pairing
codes, room identifiers, or device configuration.

## Secrets

The production relay requires `APNS_TEAM_ID`, `APNS_KEY_ID`, and the Apple `.p8`
key in `APNS_PRIVATE_KEY` only when APNs background delivery is enabled. Device
E2EE keys never belong on the relay. Store provider credentials with
`wrangler secret put`; never print or commit them.

APNs device tokens are durable routing identifiers. They are stored inside the
pairing room, protected by a hash of the room's independent push credential,
capped to eight devices, and removed when APNs reports them stale or the app
unregisters. They must never be written to logs or returned by status APIs.

Project Mesh adds no plaintext Worker field or endpoint. Project/task names,
mesh events, Task Capsules, resource claims, dependencies, handoff receipts,
and agent questions must remain inside authenticated ciphertext. Regression
tests reject these fields if they appear in relay persistence input.

Cloudflare secrets must never appear in `wrangler.toml`, `.env`,
`.dev.vars.example`, GitHub Actions variables, issues, or logs. Local
`.dev.vars` and `.env*` files are ignored by git.
