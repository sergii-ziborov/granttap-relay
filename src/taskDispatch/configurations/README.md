# Encrypted Project configuration

The room owner can replace the latest encrypted Project computer configuration
at `/task-job-configurations/:opaqueId`. Scoped task writers cannot read or
write this endpoint. The relay stores ciphertext, issuer/recipient key digests
and expiration. Clients authenticate the issuer and monotonic configuration
revision before applying anything.

This state survives the controller app closing and relay restart. It lets a
computer fetch current permission before automatic routing after being offline.
Entries are bounded to 96 KB, 128 per room and 8 MB per room, and expire within
30 days. Node cleanup and Worker alarms retire expired ciphertext. SQLite writes
and Durable Object writes commit atomically.
