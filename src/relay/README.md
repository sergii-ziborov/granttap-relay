# Relay transport modules

This module owns the public Worker request router, room Durable Object, opaque
envelope delivery, APNs wake delivery, and pairing-mailbox parking.  The relay
only validates bounded routing metadata and never decrypts payloads. Browser
approval and vault routes are absent from the Personal worker.

`../worker.js` is the Cloudflare entry point and intentionally re-exports the
public Durable Object classes and validation helpers for deployment bindings.
