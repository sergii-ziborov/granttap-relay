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

The production relay currently requires no application secrets. Device keys
never belong on the relay.

Future Cloudflare secrets must be stored with `wrangler secret put`, never in
`wrangler.toml`, `.env`, `.dev.vars.example`, GitHub Actions variables, issues,
or logs. Local `.dev.vars` and `.env*` files are ignored by git.
