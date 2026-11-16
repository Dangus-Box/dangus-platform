import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("monitores HTTPS são criados e atualizados sem duplicar", async () => {
  const dir = mkdtempSync(`${tmpdir()}/uptime-`);
  writeFileSync(
    `${dir}/bws`,
    '#!/bin/sh\nprintf \'[{"key":"platform__UPTIMEROBOT_API_KEY","value":"fake"}]\'\n',
  );
  chmodSync(`${dir}/bws`, 0o755);
  const monitors: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      expect(body.api_key).toBe("fake");
      const method = new URL(request.url).pathname.slice(1);
      if (method === "getAlertContacts")
        return Response.json({
          stat: "ok",
          pagination: { total: 1 },
          alert_contacts: [{ id: 42, status: 2 }],
        });
      if (method === "getMonitors")
        return Response.json({
          stat: "ok",
          pagination: { total: monitors.length },
          monitors,
        });
      if (method === "newMonitor")
        monitors.push({ ...body, id: monitors.length + 1 });
      else if (method === "editMonitor")
        Object.assign(monitors.find((m) => m.id === body.id) ?? {}, body);
      else return Response.json({ stat: "fail" });
      return Response.json({ stat: "ok" });
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const process = Bun.spawn(["bun", `${import.meta.dir}/uptimerobot.js`], {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          UPTIMEROBOT_API_URL: server.url.toString().replace(/\/$/, ""),
          UPTIMEROBOT_TELEGRAM_CONTACT_ID: "42",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = await new Response(process.stderr).text();
      expect({ code: await process.exited, err }).toEqual({ code: 0, err: "" });
    }
    expect(monitors.map((m) => m.url)).toEqual([
      "https://analytics.dangus-box.com/api/heartbeat",
      "https://flags.dangus-box.com/internal-backstage/health",
    ]);
    for (const monitor of monitors) {
      expect(monitor.type).toBe(1);
      expect(monitor.alert_contacts).toBe("42_0_0");
    }
  } finally {
    server.stop();
  }
});
