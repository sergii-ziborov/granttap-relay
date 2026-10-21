# Room presence

Public entries: `NodeRoomPresence`, `publishNodePresence`, `closeNodeSocket`,
and the Worker adapter `noteWorkerPresence`.

A paired socket may opt in with `X-GrantTap-Presence: 1`. After its encrypted
hello registers its existing authenticated role, the relay returns
`relay.presence` for that room. The frame contains only recipient digests,
roles, online flags and last-seen times. Online is derived from current sockets,
not from persisted state; a relay restart cannot resurrect a computer online.
Presence does not establish provider progress or authenticate task contents.

The room retains at most 32 role/key entries, dropping entries older than seven
days on updates. Other rooms are never included. Existing clients receive no
unsolicited presence frames. The phone's WebSocket connection is independent of
whether any computer is connected.
