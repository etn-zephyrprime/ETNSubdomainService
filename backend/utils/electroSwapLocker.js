// backend/utils/electroSwapLocker.js
//
// ElectroSwapLockerV2 — where an owner locks V2 LP tokens. Shared by the live LP valuation
// (lpPositionValuation.js reads the owner's locks from it) and the PnL ledger (pnlEventBuilder.js
// books LP tokens sent to / returned from it as a lock / unlock, not a disposal / acquisition).
// Lowercased, since it's compared against ingested counterparty addresses.
export const ELECTROSWAP_LOCKER_ADDRESS = (process.env.ELECTROSWAP_LOCKER_ADDRESS || "0x16ca736c8B181772009e598F37f137e9cD36AFAE").toLowerCase();
