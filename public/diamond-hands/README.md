# Diamond Hands artwork

One image per Diamond Hands outcome, shown on the score card (real Core Tier panel, the demo, and
each By Asset drill-down). Drop the files in this folder with EXACTLY these names:

| File                   | Shown when the score is          |
| ---------------------- | -------------------------------- |
| `titanium-hands.png`   | Titanium Hands (80–100)          |
| `diamond-hands.png`    | Diamond Hands (60–79)            |
| `steady-hands.png`     | Steady Hands (40–59)             |
| `paper-hands.png`      | Paper Hands (0–39)               |
| `no-data.png`          | Not enough data yet (optional)   |

Specs: square (1:1), at least 512×512, PNG, ideally under 300 KB each. They're shown as ~176px rounded
tiles with a border/glow in the tier's colour, so full-bleed artwork (own background, tier name baked
in) works as-is. A missing file falls back to a small gem icon.
