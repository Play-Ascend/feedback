// Second half of the 10-minute sync, for every open issue:
//  1. Copies new replies from the issue's Discord post onto the issue as comments.
//  2. Files the issue in Linear (team PLA) once, and remembers the Linear id in a hidden marker.
//  3. Closes the issue when its Linear issue is Done / Canceled / Duplicate, and tells the Discord post.
// Issues closed with the Actions token fire no workflow, so step 3 notifies Discord itself.
import { discord, env, github, threadIdFrom } from "./discord.mjs";
import { notifyThread } from "./notify-lib.mjs";

const REPO = env("GITHUB_REPOSITORY");
const TEAM_ID = env("LINEAR_TEAM_ID");
const COMMUNITY_LABEL_ID = env("LINEAR_LABEL_ID");
const DRY_RUN = process.env.DRY_RUN === "true";
const LAST_RE = /<!-- discord-last:(\d+) -->/;
const LINEAR_RE = /<!-- linear:([0-9a-f-]{36}) -->/;

async function linear(query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env("LINEAR_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`Linear: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

// The team's "Type" labels, so a bug lands as Bug and a feature request as Feature.
const { team } = await linear(
  `query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name parent { name } } } } }`,
  { id: TEAM_ID },
);
const typeLabel = (name) => team.labels.nodes.find((l) => l.name === name && l.parent?.name === "Type")?.id;

const open = [];
for (let page = 1; ; page++) {
  const batch = await github(`/repos/${REPO}/issues?state=open&per_page=100&page=${page}`);
  open.push(...batch.filter((i) => !i.pull_request));
  if (batch.length < 100) break;
}

const clean = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
let comments = 0, filed = 0, closed = 0;

for (const issue of open) {
  let body = issue.body ?? "";

  // 1. Follow-up replies from the Discord post (people only; the bots' own lines are skipped).
  const threadId = threadIdFrom(body);
  const last = body.match(LAST_RE)?.[1];
  if (threadId && last) {
    const messages = await discord(`/channels/${threadId}/messages?after=${last}&limit=100`).catch(() => []);
    const fresh = messages.filter((m) => !m.author?.bot && (m.content || m.attachments?.length)).reverse();
    for (const m of fresh) {
      const text = (m.content || "")
        .replace(/<@!?\d+>/g, "@member")
        .replace(/<@&\d+>/g, "@role")
        .replace(/<#\d+>/g, "#channel");
      const files = m.attachments?.length ? `\n\n_${m.attachments.length} attachment(s) in the Discord post._` : "";
      if (!DRY_RUN) {
        await github(`/repos/${REPO}/issues/${issue.number}/comments`, {
          method: "POST",
          body: JSON.stringify({ body: `**Added in Discord:**\n\n${text || "_(attachment only)_"}${files}` }),
        });
      }
      comments++;
    }
    const newest = messages.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), last);
    if (newest !== last) body = body.replace(LAST_RE, `<!-- discord-last:${newest} -->`);
  }

  // 2. File in Linear once.
  let linearId = body.match(LINEAR_RE)?.[1];
  if (!linearId) {
    const isFeature = issue.labels.some((l) => l.name === "feature");
    const labelIds = [COMMUNITY_LABEL_ID, typeLabel(isFeature ? "Feature" : "Bug")].filter(Boolean);
    const products = issue.labels.map((l) => l.name).filter((n) => !["discord", "triage", "bug", "feature"].includes(n));
    const description = [
      `Community report from [Play-Ascend/feedback#${issue.number}](${issue.html_url})${threadId ? " (Discord #bug-reports)" : ""}.`,
      products.length ? `Product: ${products.join(", ")}` : null,
      "",
      clean(body),
      "",
      "_Marking this Done or Canceled closes the public GitHub issue and tells the reporter on Discord._",
    ].filter((l) => l !== null).join("\n");
    if (DRY_RUN) {
      console.log(`[dry run] would file #${issue.number} in Linear`);
    } else {
      const created = await linear(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
        { input: { teamId: TEAM_ID, title: issue.title, description, labelIds } },
      );
      linearId = created.issueCreate.issue.id;
      await linear(
        `mutation($id: String!, $url: String!, $title: String!) { attachmentLinkURL(issueId: $id, url: $url, title: $title) { success } }`,
        { id: linearId, url: issue.html_url, title: `GitHub #${issue.number}` },
      ).catch((e) => console.warn(`Linked ${created.issueCreate.issue.identifier} without attachment: ${e.message}`));
      body = `${body}\n<!-- linear:${linearId} -->`;
      filed++;
      console.log(`#${issue.number} -> ${created.issueCreate.issue.identifier}`);
    }
  }

  if (!DRY_RUN && body !== (issue.body ?? "")) {
    await github(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
  }

  // 3. Close when Linear says it's finished.
  if (linearId && !DRY_RUN) {
    const { issue: li } = await linear(`query($id: String!) { issue(id: $id) { state { type name } } }`, { id: linearId });
    const type = li?.state?.type;
    if (type === "completed" || type === "canceled" || type === "duplicate") {
      const reason = type === "completed" ? "completed" : "not_planned";
      const updated = await github(`/repos/${REPO}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: reason }),
      });
      if (type === "duplicate") updated.state_reason = "duplicate";
      await notifyThread(updated, "closed").catch((e) => console.warn(`Closed #${issue.number}, Discord not told: ${e.message}`));
      closed++;
      console.log(`Closed #${issue.number} (${li.state.name} in Linear)`);
    }
  }
}
console.log(`Done. ${comments} follow-up comment(s), ${filed} filed in Linear, ${closed} closed.`);
