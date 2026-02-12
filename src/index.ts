const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TRACKED_USERS = (process.env.TRACKED_USERS || "")
  .split(",")
  .map((u: string) => u.trim())
  .filter(Boolean);

if (!X_BEARER_TOKEN) {
  console.error("Missing X_BEARER_TOKEN");
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL");
  process.exit(1);
}
if (TRACKED_USERS.length === 0) {
  console.error("No TRACKED_USERS configured");
  process.exit(1);
}

const STREAM_URL = "https://api.x.com/2/tweets/search/stream";
const RULES_URL = "https://api.x.com/2/tweets/search/stream/rules";

interface Tweet {
  data: {
    id: string;
    text: string;
    author_id: string;
    created_at: string;
  };
  includes?: {
    users?: Array<{
      id: string;
      username: string;
      name: string;
      profile_image_url?: string;
    }>;
  };
}

async function setRules(): Promise<void> {
  const rules = TRACKED_USERS.map((username) => ({
    value: `from:${username}`,
    tag: username,
  }));

  // First, clear existing rules
  const existingRes = await fetch(RULES_URL, {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
  });
  const existing = (await existingRes.json()) as { data?: Array<{ id: string }> };

  if (existing.data?.length) {
    await fetch(RULES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${X_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        delete: { ids: existing.data.map((r) => r.id) },
      }),
    });
    console.log(`Cleared ${existing.data.length} existing rules`);
  }

  // Add new rules
  const res = await fetch(RULES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ add: rules }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to set rules: ${err}`);
  }

  console.log(`Set rules for: ${TRACKED_USERS.join(", ")}`);
}

async function sendToDiscord(tweet: Tweet): Promise<void> {
  const user = tweet.includes?.users?.find((u) => u.id === tweet.data.author_id);
  const username = user?.username || "unknown";
  const displayName = user?.name || username;
  const avatarUrl = user?.profile_image_url;

  const tweetUrl = `https://x.com/${username}/status/${tweet.data.id}`;

  const embed = {
    author: {
      name: `${displayName} (@${username})`,
      url: `https://x.com/${username}`,
      icon_url: avatarUrl,
    },
    description: tweet.data.text,
    url: tweetUrl,
    color: 0x1da1f2, // Twitter blue
    timestamp: tweet.data.created_at,
  };

  await fetch(DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "X Feed",
      avatar_url:
        "https://abs.twimg.com/favicons/twitter.2.ico",
      embeds: [embed],
    }),
  });

  console.log(`Posted: @${username}: ${tweet.data.text.slice(0, 50)}...`);
}

async function startStream(): Promise<void> {
  console.log("Starting filtered stream...");

  const url = `${STREAM_URL}?tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name,profile_image_url`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Stream error ${res.status}: ${err}`);
    }

    if (!res.body) {
      throw new Error("No response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log("Stream ended, reconnecting in 5s...");
        setTimeout(startStream, 5000);
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) {
          // Empty line = keep-alive
          continue;
        }

        try {
          const tweet = JSON.parse(line) as Tweet;
          if (tweet.data) {
            sendToDiscord(tweet).catch((err) => console.error("Discord error:", err));
          }
        } catch {
          // Not JSON, probably a signal
        }
      }
    }
  } catch (err) {
    console.error("Stream error:", err);
    console.log("Reconnecting in 5s...");
    setTimeout(startStream, 5000);
  }
}

async function main() {
  console.log("X Discord Forwarder - X Filtered Stream → Discord Webhook");
  console.log(`Tracking users: ${TRACKED_USERS.join(", ")}`);

  await setRules();
  await startStream();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
