#!/usr/bin/env bun
// O contato Telegram é criado e confirmado no painel do UptimeRobot.
const secretsProcess = Bun.spawn(["bws", "secret", "list"], { stdout: "pipe" });
const secrets = await new Response(secretsProcess.stdout).json();
if ((await secretsProcess.exited) !== 0) throw new Error("Falha ao ler BWS");
const keys = secrets.filter(
  (secret) => secret.key === "platform__UPTIMEROBOT_API_KEY",
);
if (keys.length !== 1 || !keys[0].value)
  throw new Error("API key ausente no BWS");
const contactId = process.env.UPTIMEROBOT_TELEGRAM_CONTACT_ID;
if (!/^\d+$/.test(contactId ?? ""))
  throw new Error("Informe UPTIMEROBOT_TELEGRAM_CONTACT_ID");
const base =
  process.env.UPTIMEROBOT_API_URL ?? "https://api.uptimerobot.com/v2";
async function request(method, params = {}) {
  const response = await fetch(`${base}/${method}`, {
    method: "POST",
    body: new URLSearchParams({
      api_key: keys[0].value,
      format: "json",
      ...params,
    }),
  });
  const body = await response.json();
  if (!response.ok || body.stat !== "ok")
    throw new Error(
      `UptimeRobot ${method}: ${body.error?.message ?? response.status}`,
    );
  return body;
}
async function list(method, field, params = {}) {
  const all = [];
  for (let offset = 0; ; offset += 50) {
    const page = await request(method, { ...params, offset, limit: 50 });
    all.push(...page[field]);
    // getAlertContacts traz `total` no topo; getMonitors, em `pagination`.
    const total = page.pagination?.total ?? page.total;
    if (page[field].length === 0 || all.length >= total) return all;
  }
}
const contacts = await list("getAlertContacts", "alert_contacts");
if (
  !contacts.some(
    (contact) => String(contact.id) === contactId && contact.status === 2,
  )
)
  throw new Error(
    "Contato Telegram inexistente ou inativo; configure-o no painel",
  );
const monitors = await list("getMonitors", "monitors", {
  show_monitor_alert_contacts: 1,
});
for (const [friendly_name, url] of [
  ["Stack Ops - Umami", "https://analytics.dangus-box.com/api/heartbeat"],
  [
    "Stack Ops - Unleash Edge",
    "https://flags.dangus-box.com/internal-backstage/health",
  ],
]) {
  const matches = monitors.filter((monitor) => monitor.url === url);
  if (matches.length > 1) throw new Error(`Monitores duplicados: ${url}`);
  const params = { friendly_name, url, alert_contacts: `${contactId}_0_0` };
  // O tipo (1 = HTTP(s)) só é aceito na criação; editMonitor o rejeita.
  if (matches.length === 0) await request("newMonitor", { ...params, type: 1 });
  else
    await request("editMonitor", { ...params, id: matches[0].id, status: 1 });
  console.log(`Monitor configurado: ${friendly_name}`);
}
