# Scoped task writers

`TaskWriterGrants` is the public entry point. A paired room owner can create or
revoke a bounded grant at `PUT` / `DELETE /task-job-writers/:id?room=…`.
The relay stores a token hash, source and recipient key digests, an opaque Project
scope hash and expiry. The source receives a separate writer credential.

A writer may upload jobs only for its granted recipient and lifetime, inspect its
own jobs, or cancel its own pending jobs. It cannot list a room's jobs, read other
writers' or controller jobs, claim execution, create grants, change endpoints,
register push tokens or open a room WebSocket. The receiving computer separately
authenticates the encrypted Project operation and enforces its current policy.

Grants are immutable, revocable, bounded to 128 per room and expire within 30 days.
Node uses a SQLite transaction; Workers use a Durable Object storage transaction.
Tests exercise both actual HTTP adapters and SQLite restart isolation.
