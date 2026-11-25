import { discord, env, threadIdFrom } from "./discord.mjs";

/**
 * Tell the Discord post behind an issue that it was closed or reopened, and swap its status tag.
 * `action` is "closed" or "reopened"; `issue` is a GitHub issue object (state_reason read on close).
 */
export async function notifyThread(issue, action) {
  const threadId = threadIdFrom(issue.body);
  if (!threadId) return false;

  const forum = await discord(`/channels/${env("DISCORD_FORUM_CHANNEL_ID")}`);
  const tagId = (name) => forum.available_tags.find((t) => t.name.toLowerCase() === name)?.id;
  const statusIds = new Set(["tracked", "fixed", "closed", "off-topic"].map(tagId).filter(Boolean));

  let content;
  let status;
  if (action === "reopened") {
    content = `Reopened: <${issue.html_url}>`;
    status = "tracked";
  } else if (issue.state_reason === "completed") {
    content = `Fixed. Thanks for reporting it. <${issue.html_url}>`;
    status = "fixed";
  } else {
    const why = issue.state_reason === "duplicate" ? "as a duplicate of another report" : "without a change";
    content = `Closed ${why}. Details: <${issue.html_url}>`;
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
  return true;
}
