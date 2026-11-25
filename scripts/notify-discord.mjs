// When an issue filed from Discord is closed or reopened, say so in the original post and swap its status tag.
import { readFileSync } from "node:fs";
import { discord, env, threadIdFrom } from "./discord.mjs";

const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
const { action, issue } = event;
const threadId = threadIdFrom(issue.body);
if (!threadId) {
  console.log("Not a Discord issue, nothing to do.");
  process.exit(0);
}

const forum = await discord(`/channels/${env("DISCORD_FORUM_CHANNEL_ID")}`);
const tagId = (name) => forum.available_tags.find((t) => t.name.toLowerCase() === name)?.id;
const statusIds = new Set(["tracked", "fixed", "closed"].map(tagId).filter(Boolean));

let content;
let status;
if (action === "reopened") {
  content = `This was reopened: <${issue.html_url}>`;
  status = "tracked";
} else if (issue.state_reason === "completed") {
  content = `Fixed. Thanks for reporting it. <${issue.html_url}>`;
  status = "fixed";
} else {
  const why = issue.state_reason === "duplicate" ? "as a duplicate of another report" : "without a change";
  content = `This was closed ${why}. Details: <${issue.html_url}>`;
  status = "closed";
}

const thread = await discord(`/channels/${threadId}`);
if (thread.thread_metadata?.archived) {
  await discord(`/channels/${threadId}`, { method: "PATCH", body: JSON.stringify({ archived: false }) });
}
await discord(`/channels/${threadId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
});
const kept = (thread.applied_tags ?? []).filter((id) => !statusIds.has(id));
const next = tagId(status);
await discord(`/channels/${threadId}`, {
  method: "PATCH",
  body: JSON.stringify({ applied_tags: [...kept, ...(next ? [next] : [])].slice(0, 5) }),
});
console.log(`Posted "${status}" to thread ${threadId}`);
