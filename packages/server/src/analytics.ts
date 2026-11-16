export async function trackEvent(event: {
  name: string;
  hostname: string;
  url: string;
  data?: Record<string, string | number | boolean>;
}): Promise<void> {
  const website = process.env.UMAMI_WEBSITE_ID;
  if (!website) return;
  const response = await fetch(
    `${(process.env.UMAMI_URL || "http://dangus-ops-umami:3000").replace(/\/$/, "")}/api/e`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; DangusPlatform/1.0)",
      },
      body: JSON.stringify({ type: "event", payload: { website, ...event } }),
    },
  );
  if (!response.ok) throw new Error(`Umami: HTTP ${response.status}`);
}
