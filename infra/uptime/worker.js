const URLS = [
  "https://analytics.dangus-box.com/api/heartbeat",
  "https://flags.dangus-box.com/internal-backstage/health",
];

export async function check(env, request = fetch) {
  const targets = (await env.UPTIME_KV.get("targets", "json")) ?? URLS;
  const results = await Promise.allSettled(
    targets.map(async (url) => {
      const state = (await env.UPTIME_KV.get(url, "json")) ?? {
        down: false,
        failures: 0,
      };
      let ok = false;
      try {
        const response = await request(url, {
          signal: AbortSignal.timeout(5000),
        });
        ok = response.ok;
      } catch {
        // Timeouts and network failures count as downtime.
      }
      const failures = ok ? 0 : Math.min(state.failures + 1, 2);
      const down = ok ? false : state.down || failures >= 2;
      if (down !== state.down) {
        const response = await request(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `${down ? "Unavailable" : "Recovered"}: ${url}`,
            }),
          },
        );
        if (!response.ok || !(await response.json()).ok)
          throw new Error("Failed to send Telegram alert");
      }
      // The free plan allows 1,000 KV writes per day.
      if (down !== state.down || failures !== state.failures)
        await env.UPTIME_KV.put(url, JSON.stringify({ down, failures }));
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
};
