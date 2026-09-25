// Anyone holding more than 49 of "The Three Graces Of The Sea" (SEAS, an ERC-721 collection at
// 0x1760321f42A9BE39b39c779D92373769d829ef48) is a confirmed genuine Electroneum team wallet —
// see that collection's own holders list:
// https://blockexplorer.electroneum.com/token/0x1760321f42A9BE39b39c779D92373769d829ef48?tab=holders
// Snapshotted 2026-09-15 (11 wallets from that list, >49 SEAS each) plus 10 additional wallets
// confirmed separately (one on 2026-09-15, five more the same day, four more on 2026-09-16). This
// is a point-in-time list,
// not a live on-chain check — re-verify against that collection's holders if the team's own
// wallets are ever reorganized. Kept in sync by hand with the backend's own copy
// (backend/utils/teamWalletsCache.js's TEAM_WALLET_ADDRESSES) — no shared build step between
// frontend/backend in this repo, same "small per-file lists are fine to drift independently, just
// keep them in sync by hand" convention this codebase already follows elsewhere (e.g.
// TOKEN_DECIMALS_BY_ADDRESS). Used two ways here: this static list powers the inline "ETN Team"
// tag shown wherever the dashboard renders a wallet address (synchronous, no network dependency);
// TeamWalletsTab.jsx's own balance/movement data comes from the separate, R2-cached backend feed
// instead (useTeamWallets.js), not from re-deriving anything off this list.
export const TEAM_WALLET_ADDRESSES = [
  "0xBdaFE4294F92039CCc2C97C74d046871F0b65BCB",
  "0xF0E7d64Ede6c56bEa9160E560f602Dd6E409f2cC",
  "0x4635D3e2d056A428fe32Db124528D74DC529D349",
  "0xEB258553BCf9134C02543E284671f6b4c48e2a7C",
  "0xcFb24d4CBAaA5630CBC7a516A6A094A593D624fd",
  "0xb40b04636D058Da2d10111e50417344479878907",
  "0x904403D9a0f591AC1cA12acBF8d80DC79b5c7E94",
  "0xcae0eBB25FdDe03B339B00FA2bdB05b9FE9FC6E0",
  "0x0bC0Fac6c972C4a0320dA6Ef20aB3526F375784B",
  "0x1F2407b300a3C768fF4531A751BD59D538e6d20E",
  "0x32Fd79d48d104c404fCcA35CfCD56Fff77082332",
  "0xc873974Ec3161b82FB0C28f587c348b00fCebD30",
  "0x217444Ce087deB274726Cb8CdfB636c35F039593",
  "0xa94E524197717DAE43b767B8B492C45d4d5EF0De",
  "0xd8185212c609a99c3446E7044D605C6732bdae7a",
  "0x096121F2f56b390eb2c7Dd02F8746450345d8255",
  "0x9266c334BABCEfE07577bE4C34C9D9028c4BDb03",
  "0x3C85Da8873F0baC9F22222a9887554a657D54312",
  "0x1fe3c69EF519f3452c4370CeCB77514773DaF56D",
  "0x90e5B91d961d3E1288311389d6cBA5cE6b053551",
  "0xB62d61E4077dD40d3a152E60F9f678860bAf026F",
  "0xC25CfD4901aA9b43ab81A57b423fd5D17ace9545", // added 2026-09-25 — suspected, not SEAS-verified yet
];

const TEAM_WALLET_SET = new Set(TEAM_WALLET_ADDRESSES.map((a) => a.toLowerCase()));

export function isTeamWallet(address) {
  return !!address && TEAM_WALLET_SET.has(address.toLowerCase());
}
