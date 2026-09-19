import React from "react";

// Dotted "leader" line filling the gap between a row's label and its value (like a table of
// contents) so the eye can follow across on wide screens instead of losing the row when the two
// ends sit hundreds of pixels apart. Drop it between the two children of a flex row that's
// `alignItems: "center"`; it takes whatever space is left and collapses to nothing when there's none.
export default function RowLeader() {
  return (
    <span
      aria-hidden="true"
      style={{ flex: 1, minWidth: 8, height: 0, borderTop: "1px dotted rgba(255,255,255,0.22)" }}
    />
  );
}
