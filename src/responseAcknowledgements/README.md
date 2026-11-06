# Delivery response acknowledgements

Public entry: `createResponseAcknowledgements` in `index.js`. The Node socket
delivery path grants one response allowance for an identifier it actually sends
to that socket. This prevents a returning controller from hitting the command
rate limit merely by acknowledging the relay's retained replay.

Each socket retains at most 512 identifiers, each at most 180 characters, for
30 seconds. An exact acknowledgement of at most 1536 bytes consumes its allowance
once. Another socket, an expired/unknown/repeated acknowledgement, extra fields,
and all other frames use the unchanged 300-frame command/unsolicited limit.
No response allowance admits an encrypted command or exempts it from validation.
Allowances are local to the connection and cannot alter durable delivery state.
Retained read snapshots still survive delivery acknowledgements.

The Worker deployment keeps its existing frame policy; this module addresses
the self-hosted Node replay path. Local unit tests and the retained-state TCP
test verify the bound, expiry, isolation, complete replay and abuse closure.
