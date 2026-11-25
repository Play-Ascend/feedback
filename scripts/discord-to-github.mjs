// Files every new #bug-reports forum post as a GitHub issue, replies in the post with the link,
// and tags the post "Tracked". Safe to run repeatedly: a post is filed once (see marker()).
import { discord, env, github, labelFor, marker, threadIdFrom } from "./discord.mjs";

const FORUM_ID = env("DISCORD_FORUM_CHANNEL_ID");
const GUILD_ID = env("DISCORD_GUILD_ID");
const REPO = env("GITHUB_REPOSITORY");
const DRY_RUN = process.env.DRY_RUN === "true";
// Status tags are set by the bot, not by members.
const STATUS_TAGS = new Set(["tracked", "fixed", "closed", "off-topic"]);
// Posts Ascend AI or a mod marked as not a report (questions, off-topic, abuse) are never filed.
const SKIP_TAGS = new Set(["off-topic", "closed"]);

const forum = await discord(`/channels/${FORUM_ID}`);
const tagsById = new Map(forum.available_tags.map((t) => [t.id, t]));
const trackedTag = forum.available_tags.find((t) => t.name.toLowerCase() === "tracked");

// Active threads plus recently archived ones, so a post that auto-archived between runs is not missed.
const active = await discord(`/guilds/${GUILD_ID}/threads/active`);
const archived = await discord(`/channels/${FORUM_ID}/threads/archived/public?limit=50`);
const threads = [...active.threads.filter((t) => t.parent_id === FORUM_ID), ...archived.threads];

// Every thread already filed, from the markers in issues carrying the "discord" label.
const filed = new Set();
for (let page = 1; ; page++) {
  const issues = await github(`/repos/${REPO}/issues?labels=discord&state=all&per_page=100&page=${page}`);
  for (const issue of issues) {
    const id = threadIdFrom(issue.body);
    if (id) filed.add(id);
  }
  if (issues.length < 100) break;
}

const seen = new Set();
let created = 0;
for (const thread of threads) {
  if (seen.has(thread.id) || filed.has(thread.id)) continue;
  seen.add(thread.id);

  // A forum post's starter message has the same id as the thread.
  const starter = await discord(`/channels/${thread.id}/messages/${thread.id}`).catch(() => null);
  if (!starter || starter.author?.bot) continue;

  const tags = (thread.applied_tags ?? []).map((id) => tagsById.get(id)?.name).filter(Boolean);
  if (thread.thread_metadata?.locked || tags.some((name) => SKIP_TAGS.has(name.toLowerCase()))) {
    console.log(`Skipped thread ${thread.id}: ${thread.thread_metadata?.locked ? "locked" : "off-topic or closed"}`);
    continue;
  }
  const productTags = tags.filter((name) => !STATUS_TAGS.has(name.toLowerCase()));
  // Mentions are rewritten so no Discord ids or names reach the public issue.
  const text = (starter.content || "_No description._")
    .replace(/<@!?\d+>/g, "@member")
    .replace(/<@&\d+>/g, "@role")
    .replace(/<#\d+>/g, "#channel");
  const files = starter.attachments?.length ?? 0;
  const threadUrl = `https://discord.com/channels/${GUILD_ID}/${thread.id}`;

  const body = [
    text,
    "",
    "---",
    `Reported in [#bug-reports on the Ascend Discord](${threadUrl})${productTags.length ? ` · ${productTags.join(", ")}` : ""}.`,
    files ? `${files} attachment${files === 1 ? "" : "s"} in the Discord post.` : null,
    marker(thread.id),
    `<!-- discord-last:${thread.id} -->`,
  ]
    .filter((line) => line !== null)
    .join("\n");
  // "Bug" / "Idea" tags become the bug / feature labels; the rest are product names.
  const labels = ["discord", "triage", ...productTags.map((name) => (labelFor(name) === "idea" ? "feature" : labelFor(name)))];

  if (DRY_RUN) {
    console.log(`[dry run] would file "${thread.name}" with labels ${labels.join(", ")}`);
    continue;
  }

  const issue = await github(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: thread.name.slice(0, 250), body, labels }),
  });
  created++;
  console.log(`Filed #${issue.number} from thread ${thread.id}`);

  // The reply and the tag are best effort: the issue exists either way.
  try {
    if (thread.thread_metadata?.archived) {
      await discord(`/channels/${thread.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) });
    }
    await discord(`/channels/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `Tracked as [#${issue.number}](<${issue.html_url}>).`,
        allowed_mentions: { parse: [] },
      }),
    });
    if (trackedTag) {
      const applied = [...new Set([...(thread.applied_tags ?? []), trackedTag.id])].slice(0, 5);
      await discord(`/channels/${thread.id}`, { method: "PATCH", body: JSON.stringify({ applied_tags: applied }) });
    }
  } catch (error) {
    console.warn(`Filed #${issue.number} but could not update thread ${thread.id}: ${error.message}`);
  }
}
console.log(`Done. ${created} new issue(s).`);
