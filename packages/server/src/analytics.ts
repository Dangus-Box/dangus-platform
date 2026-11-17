const timeoutMs = 3000;

export async function trackEvent(event: {
  name: string;
  hostname: string;
  url: string;
  data?: Record<string, string | number | boolean>;
}): Promise<void> {
  const website = process.env.UMAMI_WEBSITE_ID;
  if (!website) return;
  try {
    const response = await fetch(
      `${(process.env.UMAMI_URL || "http://dangus-ops-umami:3000").replace(/\/$/, "")}/api/e`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) DangusPlatform/1.0", // Umami rejects User-Agents with "compatible;" as bots.
        },
        body: JSON.stringify({ type: "event", payload: { website, ...event } }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) console.warn(`Umami: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`Umami: ${error instanceof Error ? error.message : error}`);
  }
}
