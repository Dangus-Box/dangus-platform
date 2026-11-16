import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const apiKey = "fake-api-key-secret";
const urls = [
  "https://analytics.dangus-box.com/api/heartbeat",
  "https://flags.dangus-box.com/internal-backstage/health",
];
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop());

// API falsa com as formas de resposta documentadas da API v2 (legacy):
// getAlertContacts traz `total` no topo; getMonitors traz `pagination`.
function fakeApi(fail?: string) {
  const monitors: Record<string, string | number>[] = [];
  const calls: Record<string, string>[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = Object.fromEntries(
        (await request.formData()).entries(),
      ) as Record<string, string>;
      const method = new URL(request.url).pathname.slice(1);
      calls.push({ method, ...body });
      if (body.api_key !== apiKey)
        return Response.json({ stat: "fail", error: { message: "api_key" } });
      if (method === fail)
        return Response.json({ stat: "fail", error: { message: "boom" } });
      if (method === "getAlertContacts")
        return Response.json({
          stat: "ok",
          offset: 0,
          limit: 50,
          total: 2,
          alert_contacts: [
            { id: "41", type: 2, status: 2 },
            { id: "42", type: 18, status: 2 },
          ],
        });
      if (method === "getMonitors")
        return Response.json({
          stat: "ok",
          pagination: { offset: 0, limit: 50, total: monitors.length },
          monitors,
        });
      if (method === "newMonitor") {
        monitors.push({ ...body, id: monitors.length + 1 });
        return Response.json({ stat: "ok", monitor: { id: monitors.length } });
      }
      if (method === "editMonitor") {
        if ("type" in body)
          return Response.json({
            stat: "fail",
            error: { message: "type can not be edited" },
          });
        Object.assign(
          monitors.find((m) => String(m.id) === body.id) ?? {},
          body,
        );
        return Response.json({ stat: "ok" });
      }
      return Response.json({ stat: "fail" });
    },
  });
  return { monitors, calls };
}

async function run(contactId = "42") {
  const dir = mkdtempSync(`${tmpdir()}/uptime-`);
  writeFileSync(
    `${dir}/bws`,
    `#!/bin/sh\nprintf '[{"key":"platform__UPTIMEROBOT_API_KEY","value":"${apiKey}"}]'\n`,
  );
  chmodSync(`${dir}/bws`, 0o755);
  const proc = Bun.spawn(["bun", `${import.meta.dir}/uptimerobot.js`], {
    env: {
      ...Bun.env,
      PATH: `${dir}:${Bun.env.PATH}`,
      UPTIMEROBOT_API_URL: server?.url.origin,
      UPTIMEROBOT_TELEGRAM_CONTACT_ID: contactId,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output =
    (await new Response(proc.stdout).text()) +
    (await new Response(proc.stderr).text());
  return { code: await proc.exited, output };
}

test("monitores HTTPS são criados e atualizados sem duplicar", async () => {
  const { monitors } = fakeApi();
  for (let i = 0; i < 2; i++) expect((await run()).code).toBe(0);
  expect(monitors.map((m) => m.url)).toEqual(urls);
  for (const monitor of monitors) {
    expect(monitor.type).toBe("1");
    expect(monitor.alert_contacts).toBe("42_0_0");
  }
});

test("contato inexistente falha sem criar monitores", async () => {
  const { calls } = fakeApi();
  const { code, output } = await run("99");
  expect(code).not.toBe(0);
  expect(output).toContain("Contato Telegram");
  expect(calls.some((c) => c.method === "newMonitor")).toBe(false);
});

test("erro da API falha sem vazar a API key", async () => {
  fakeApi("newMonitor");
  const { code, output } = await run();
  expect(code).not.toBe(0);
  expect(output).toContain("UptimeRobot newMonitor: boom");
  expect(output).not.toContain(apiKey);
});
