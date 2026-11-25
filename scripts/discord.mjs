// Small shared helpers for the Discord and GitHub REST APIs. No dependencies.
const DISCORD = "https://discord.com/api/v10";

export function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export async function discord(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${DISCORD}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}`,
        "Content-Type": "application/json",
        // Discord blocks requests without a DiscordBot user agent (error 1010).
        "User-Agent": "DiscordBot (https://github.com/Play-Ascend/feedback, 1.0)",
        ...init.headers,
      },
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000) + 250));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`Discord ${path} still rate limited after retries`);
}

export async function github(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Marker written into every synced issue so a thread is never filed twice. */
export const marker = (threadId) => `<!-- discord-thread:${threadId} -->`;
export const threadIdFrom = (body) => body?.match(/<!-- discord-thread:(\d+) -->/)?.[1] ?? null;

/** "Ascend AI" -> "ascend-ai" */
export const labelFor = (tagName) => tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
