// The App Check overall badge and its one-line reason — computed in code from the facts, worded by
// templates (no Claude). Rules:
//   lookalike -> red, always.
//   known     -> the worst of its contracts' own Contract Check badges (whatever caps those already apply)
//                and its domain flags. Being listed never hides or lowers a flag. A contract we couldn't
//                check keeps a clean known app at "unassessed" — missing data is never green and never a flag.
//   unknown   -> the worst of the scanned contracts and the domain flags, but NEVER green: a clean result
//                is "unassessed" (we can't confirm who runs the site).
//   invalid   -> no badge.
// Template text only ever contains registry data (ours) and counts; site-controlled text never goes in here.

const COLOUR_RANK = { green: 0, amber: 1, red: 2 };
const FLAG_COLOUR = { high: "red", caution: "amber" };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
 */
export function computeOverall({ status, app = null, resembles = null, contracts = [], domainFlags = [], scan = null }) {
  if (status === "invalid") return { overall: null, overallReason: "That isn't a website address we can check." };
  if (status === "lookalike") {
    return { overall: "red", overallReason: `This site resembles ${resembles} (${app.name}) but isn't a listed site for it. Don't connect your wallet or sign anything here.` };
  }

  const checked = contracts.filter((c) => c.overall && c.overall !== "unknown");
  const unchecked = contracts.length - checked.length;
  const red = checked.filter((c) => c.overall === "red").length;
  const amber = checked.filter((c) => c.overall === "amber").length;
  const worst = worstColour(checked, domainFlags);
  const domainWorst = worstColour([], domainFlags);
  const flagged = () => {
    const parts = [];
    if (red) parts.push(`${plural(red, "contract")} with high-severity flags`);
    if (amber) parts.push(`${plural(amber, "contract")} with caution flags`);
    if (domainWorst !== "green") parts.push("domain warnings");
    return parts.join(" and ");
  };

  if (status === "known") {
    if (worst !== "green") return { overall: worst, overallReason: `Listed site for ${app.name}, but we found ${flagged()}. Being listed doesn't remove a flag — see the details.` };
    if (unchecked) return { overall: "unassessed", overallReason: `Listed site for ${app.name}. We couldn't check ${unchecked} of its ${contracts.length} contracts right now, so we can't give it a badge yet.` };
    if (!contracts.length) return { overall: "green", overallReason: `Listed site for ${app.name}. It has no contracts in our registry to check.` };
    return { overall: "green", overallReason: `Listed site for ${app.name}. No red flags in its ${plural(contracts.length, "listed contract")}.` };
  }

  // unknown: never green
  if (worst !== "green") return { overall: worst, overallReason: `Not in our registry, and we found ${flagged()}.` };
  if (!scan) return { overall: "unassessed", overallReason: "We haven't scanned this site. It isn't in our registry, so we can't confirm who runs it." };
  if (scan.status !== "ok") return { overall: "unassessed", overallReason: "We couldn't scan all of this site, so we can't say what it uses. It isn't in our registry, so we can't confirm who runs it." };
  if (!contracts.length) return { overall: "unassessed", overallReason: "No contracts found in this site's code (it may load addresses dynamically, or not use contracts). It isn't in our registry, so we can't confirm who runs it." };
  return { overall: "unassessed", overallReason: "No red flags found in the contracts we could see. This site isn't in our registry, so we can't confirm who runs it." };
}
