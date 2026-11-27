// backend/scripts/registerDiscordTapCommands.js
//
// Registers the Discord tap bot's slash commands for DMs (user-installed app). Run once after
// creating the app or changing the commands: node scripts/registerDiscordTapCommands.js
import dotenv from "dotenv";

dotenv.config();

const appId = process.env.DISCORD_TAP_APP_ID;
const token = process.env.DISCORD_TAP_BOT_TOKEN;
if (!appId || !token) throw new Error("DISCORD_TAP_APP_ID and DISCORD_TAP_BOT_TOKEN must be set");

const commands = [
  { name: "tap", description: "Open the tap menu", integration_types: [1], contexts: [1] },
  { name: "statto", description: "Show tap stats and the leaderboard", integration_types: [1], contexts: [1] },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
if (!res.ok) throw new Error(`Registering commands failed: ${res.status} ${await res.text()}`);
console.log(`Registered ${(await res.json()).length} Discord tap commands`);
