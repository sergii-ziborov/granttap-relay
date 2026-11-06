# Private activity routes

`index.js` exposes storage for encrypted Live Activity enrollment. The private
route includes an APNs token; `list` returns only the enrollment box and expiry.
Room boundaries, capacity, expiry and delivery receipts remain durable across
restart. Token rotation preserves the receipt for an already accepted update.

Tests live in `tests/`. The repository GrantTap Commercial Source License applies.
