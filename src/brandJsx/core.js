// Sets the words "ETN" and "Electroneum" in the Orbitron brand font, everywhere they are rendered as text.
//
// HOW. vite.config.js points the automatic JSX runtime at this folder (jsxImportSource), so every JSX element
// in the app is created through the wrappers in jsx-runtime.js / jsx-dev-runtime.js. For an HTML element whose
// children are text, the wrapper finds the two brand words and wraps just them in a span with the brand font.
// It happens at render time, inside React — so React still owns every DOM node and later updates work
// normally (post-processing the DOM instead would fight React's reconciliation).
//
// WHAT IT COVERS: any text a component renders as an element's child — JSX literals, template strings,
// values returned by formatters, tooltip text — because they all end up as string children of an element.
// WHAT IT CAN'T: text that isn't element content — <option> labels, input placeholders, title/alt
// attributes, the browser tab title, SVG <text> — where HTML styling isn't possible.
//
// LAYOUT SAFETY. A run of adjacent text ("12.3", " ETN") is rewritten as ONE inline span, exactly where the
// run was, so a flex/grid parent still sees a single item and keeps its spacing (splitting it into several
// siblings would drop the whitespace between them). Components' own `children` props are never touched — only
// the children of real HTML elements.
//
// OFF BY DEFAULT: the main ENS site shares this build, so main.jsx switches it on only for the dashboard.
import { jsx as baseJsx, jsxs as baseJsxs } from "react/jsx-runtime";

// "ETN" (also at the start of a CamelCase name such as ETNBridge, but not inside a lowercase word) and "Electroneum".
const BRAND_WORDS = /\b(ETN(?![a-z])|Electroneum)/;
const BRAND_WORDS_G = /\b(ETN(?![a-z])|Electroneum)/g;
// Elements whose content can't hold styled child elements (or isn't HTML text).
const SKIP = new Set(["option", "title", "textarea", "style", "script", "text", "tspan", "input", "select", "code", "pre"]);
const BRAND_STYLE = { fontFamily: '"Orbitron", sans-serif' };

let enabled = false;
export function enableBrandFont() {
  enabled = true;
}

const isText = (c) => typeof c === "string" || typeof c === "number";
const isBlank = (c) => c === null || c === undefined || typeof c === "boolean"; // renders nothing — doesn't split a run

/** `"Combined ETN Balance"` -> `<span>Combined <span brand>ETN</span> Balance</span>`. */
function brandRun(text) {
  const parts = text.split(BRAND_WORDS_G); // odd indexes are the captured brand words
  const nodes = parts.map((part, i) => (i % 2 === 1 ? baseJsx("span", { style: BRAND_STYLE, children: part }, i) : part)).filter((p) => p !== "");
  return baseJsxs("span", { children: nodes });
}

/** Rewrites the brand words in a string, or in each run of adjacent strings/numbers in an array of children.
 * Returns the SAME reference when there is nothing to change. Exported for tests. */
export function brandChildren(children) {
  if (typeof children === "string") return BRAND_WORDS.test(children) ? brandRun(children) : children;
  if (!Array.isArray(children)) return children;

  let changed = false;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const text = run.filter(isText).map(String).join("");
    if (BRAND_WORDS.test(text)) {
      out.push(brandRun(text));
      changed = true;
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const child of children) {
    if (isText(child)) run.push(child);
    else if (isBlank(child)) run.length ? run.push(child) : out.push(child); // transparent inside a run
    else { flush(); out.push(child); }
  }
  flush();
  return changed ? out : children;
}

/** Wraps one of React's jsx factories so element children get the brand treatment. */
export function withBrandFont(factory) {
  return (type, props, ...rest) => {
    if (enabled && typeof type === "string" && !SKIP.has(type) && props && props.children != null && props.dangerouslySetInnerHTML == null) {
      const children = brandChildren(props.children);
      if (children !== props.children) props = { ...props, children };
    }
    return factory(type, props, ...rest);
  };
}
