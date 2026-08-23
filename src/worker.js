/**
 * Cloudflare Worker public entry point for the encrypted GrantTap relay.
 * Feature implementations live in `relay/` so deployment bindings and public
 * imports remain stable while each concern stays small and independently tested.
 */

import { routeRequest } from "./relay/requestRouter.js";

export { GrantTapCodes } from "./relay/pairingMailbox.js";
export { pushPayload } from "./relay/apnsWake.js";
export { GrantTapRoom } from "./relay/room.js";
export {
  validDeviceToken,
  validEnvelope,
  validRoom,
  validRoomCredential,
} from "./relay/relayValidation.js";

export default { fetch: routeRequest };
