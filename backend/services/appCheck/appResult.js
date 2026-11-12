// The App Check overall badge and its one-line reason — computed in code from the facts, worded by
// templates (no Claude). Rules:
//   lookalike -> red, always.
//   known     -> the worst of its contracts' own Contract Check badges (whatever caps those already apply)
//                and its domain flags. Being listed never hides or lowers a flag. A contract we couldn't
//                check keeps a clean known app at "unassessed" — missing data is never green and never a flag.
//                An app with NO listed contracts takes the contracts found by scanning its site instead
//                ("unassessed" until it's scanned) — being listed alone is never a green.
//   unknown   -> the worst of the scanned contracts and the domain flags, but NEVER green: a clean result
//                is "unassessed" (we can't confirm who runs the site).
//   invalid   -> no badge.
// Template text only ever contains registry data (ours) and counts; site-controlled text never goes in here.

const COLOUR_RANK = { green: 0, amber: 1, red: 2 };
const FLAG_COLOUR = { high: "red", caution: "amber" };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * How a known app is described. An app from the block explorer's Apps list is "on the Electroneum block
 * explorer's app list" — that's a listing, not a check by us, so it never reads as our endorsement.
 */
export const listedAs = (app) => (app?.source === "explorer" ? `On the Electroneum block explorer's app list as ${app.name}` : `Listed site for ${app.name}`);

/** The worst colour among the contracts' badges and the flags' severities: "red" | "amber" | "green". */
export function worstColour(contracts, flags) {
  let worst = "green";
  const bump = (c) => {
    if (c && COLOUR_RANK[c] > COLOUR_RANK[worst]) worst = c;
  };
  for (const c of contracts) bump(c.overall);
  for (const f of flags) bump(FLAG_COLOUR[f.severity]);
  return worst;
}

/**
 * `{ overall, overallReason }`.
 * @param r.status "known" | "lookalike" | "unknown" | "invalid"
 * @param r.app the known app (known) or the one it resembles (lookalike)
 * @param r.resembles the listed host it resembles (lookalike)
 * @param r.contracts [{ overall: "red" | "amber" | "green" | "unknown" }]
 * @param r.domainFlags [{ severity }]
 * @param r.scan null (not scanned) or { status: "ok" | "partial" | "failed" }
 * @param r.fromScan (known) the app has no listed contracts, so `contracts` are the ones its scan found
 */
export function computeOverall({ status, app = null, resembles = null, contracts = [], domainFlags = [], scan = null, fromScan = false }) {
  if (status === "invalid") return { overall: null, overallReason: "That isn't a website address we can check." };
  if (status === "lookalike") {
    return { overall: "red", overallReason: `This site resembles ${resembles} (${app.name}) but isn't a listed site for it. Don't connect your wallet or sign anything here.` };
  }

  const checked = contracts.filter((c) => c.overall && c.overall !== "unknown");
  const unchecked = contracts.length - checked.length;
  const red = checked.filter((c) => c.overall === "red").length;
  const amber = checked.filter((c) => c.overall === "amber").length;
  const worst = worstColour(checked, domainFlags);
  // "flags" here = the domain's AND the scan's (assembleResult passes both); name them by what they are
  const usesOthers = domainFlags.filter((f) => f.id === "uses_known_app_contracts" && FLAG_COLOUR[f.severity]);
  const domainWorst = worstColour([], domainFlags.filter((f) => f.id !== "uses_known_app_contracts"));
  const flagged = () => {
    const parts = [];
    if (red) parts.push(`${plural(red, "contract")} with high-severity flags`);
    if (amber) parts.push(`${plural(amber, "contract")} with caution flags`);
    if (usesOthers.length) parts.push(usesOthers.length === 1 ? "a listed app's contracts on a site that isn't listed for it" : "listed apps' contracts on a site that isn't listed for them");
    if (domainWorst !== "green") parts.push("domain warnings");
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
  };

  if (status === "known") {
    if (worst !== "green") return { overall: worst, overallReason: `${listedAs(app)}, but we found ${flagged()}. Being listed doesn't remove a flag — see the details.` };
    if (unchecked) return { overall: "unassessed", overallReason: `${listedAs(app)}. We couldn't check ${unchecked} of its ${contracts.length} contracts right now, so we can't give it a badge yet.` };
    if (fromScan) {
      // no contracts listed for it: the badge is the contracts found in its own site's code — never a free
      // green for being listed
      if (!scan) return { overall: "unassessed", overallReason: `${listedAs(app)}. We don't list its contracts and haven't scanned the site yet — scan it to check the contracts it uses.` };
      if (scan.status !== "ok") return { overall: "unassessed", overallReason: `${listedAs(app)}. We couldn't scan all of its site, so we can't give it a badge yet.` };
      if (!contracts.length) return { overall: "green", overallReason: `${listedAs(app)}. No contracts found in its site's code (it may load addresses dynamically, or not use contracts).` };
      return { overall: "green", overallReason: `${listedAs(app)}. No red flags in the ${plural(contracts.length, "contract")} found in its site's code.` };
    }
    return { overall: "green", overallReason: `${listedAs(app)}. No red flags in its ${plural(contracts.length, "listed contract")}.` };
  }

  // unknown: never green
  if (worst !== "green") return { overall: worst, overallReason: `Not in our registry, and we found ${flagged()}.` };
  if (!scan) return { overall: "unassessed", overallReason: "We haven't scanned this site. It isn't in our registry, so we can't confirm who runs it." };
  if (scan.status !== "ok") return { overall: "unassessed", overallReason: "We couldn't scan all of this site, so we can't say what it uses. It isn't in our registry, so we can't confirm who runs it." };
  if (!contracts.length) return { overall: "unassessed", overallReason: "No contracts found in this site's code (it may load addresses dynamically, or not use contracts). It isn't in our registry, so we can't confirm who runs it." };
  return { overall: "unassessed", overallReason: "No red flags found in the contracts we could see. This site isn't in our registry, so we can't confirm who runs it." };
}
