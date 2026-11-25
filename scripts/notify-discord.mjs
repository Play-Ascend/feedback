// Runs on GitHub "issues: closed / reopened" (a person closing the issue on GitHub).
import { readFileSync } from "node:fs";
import { env } from "./discord.mjs";
import { notifyThread } from "./notify-lib.mjs";

const { action, issue } = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
const done = await notifyThread(issue, action);
console.log(done ? `Posted "${action}" to Discord for #${issue.number}` : "Not a Discord issue, nothing to do.");
