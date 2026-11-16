import { UnleashWebProvider } from "@openfeature/unleash-web-provider";
import { OpenFeature } from "@openfeature/web-sdk";

const server = process.env.UNLEASH_URL;
const edge = process.env.EDGE_URL;
const json = { "content-type": "application/json" };
const login = await fetch(`${server}/auth/simple/login`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({
    username: "admin",
    password: process.env.UNLEASH_ADMIN_PASSWORD,
  }),
  redirect: "manual",
});
if (!login.ok) throw new Error(`Login: ${login.status} ${await login.text()}`);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Login falhou");
const headers = { ...json, cookie };
const created = await fetch(`${server}/api/admin/projects/default/features`, {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "teste-web", type: "release" }),
});
if (!created.ok) throw new Error(await created.text());
await OpenFeature.setProviderAndWait(
  new UnleashWebProvider({
    url: `${edge}/api/frontend`,
    clientKey: process.env.UNLEASH_FRONTEND_TOKEN ?? "",
    appName: "web",
    refreshInterval: 1,
    disableMetrics: true,
  }),
);
const client = OpenFeature.getClient();
if (client.getBooleanValue("teste-web", false))
  throw new Error("Flag inicial incorreta");
const enabled = await fetch(
  `${server}/api/admin/projects/default/features/teste-web/environments/production/on`,
  { method: "POST", headers },
);
if (!enabled.ok) throw new Error(await enabled.text());
for (let i = 0; i < 90; i++) {
  if (client.getBooleanValue("teste-web", false)) {
    console.log(
      "Flag alterada no Unleash observada pelo OpenFeature web sem rebuild OK",
    );
    await OpenFeature.close();
    process.exit(0);
  }
  await Bun.sleep(1000);
}
throw new Error("Flag não atualizou");
