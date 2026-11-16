const URLS = [
  "https://analytics.dangus-box.com/api/heartbeat",
  "https://flags.dangus-box.com/internal-backstage/health",
];

export async function check(env, request = fetch) {
  await Promise.all(
    URLS.map(async (url) => {
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
        // Timeout e falhas de rede contam como indisponibilidade.
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
              text: `${down ? "Indisponível" : "Recuperado"}: ${url}`,
            }),
          },
        );
        if (!response.ok || !(await response.json()).ok)
          throw new Error("Falha ao enviar alerta ao Telegram");
      }
      await env.UPTIME_KV.put(url, JSON.stringify({ down, failures }));
    }),
  );
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
};
