// Cross-platform local dev entrypoint — sets a default PORT before starting the server, so
// `npm run start:local` works the same in cmd.exe, PowerShell, and bash without relying on
// shell-specific inline env var syntax. 3002 avoids colliding with the frontend's Vite dev
// server, which often ends up on 3001 (its own default 3000 is commonly taken too).
process.env.PORT ||= "3002";
await import("./index.js");
