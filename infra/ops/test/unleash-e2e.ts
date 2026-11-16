import { OpenFeature } from "../../../packages/server/node_modules/@openfeature/server-sdk";
import { configureFlags } from "../../../packages/server/src/index";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ausente`);
  return value;
};
const server = process.env.UNLEASH_URL;
const edge = process.env.EDGE_URL;
const json = { "content-type": "application/json" };
async function login(password: string) {
  return fetch(`${server}/auth/simple/login`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "admin", password }),
    redirect: "manual",
  });
}
const good = await login(required("UNLEASH_ADMIN_PASSWORD"));
if (good.status !== 200)
  throw new Error(`Login: ${good.status} ${await good.text()}`);
const cookie = good.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Cookie ausente");
const bad = await login("unleash4all");
if (bad.status < 400) throw new Error("Senha padrão aceita");
console.log("Login com senha configurada e rejeição da senha padrão OK");
const admin = { ...json, cookie };
const created = await fetch(`${server}/api/admin/projects/default/features`, {
  method: "POST",
  headers: admin,
  body: JSON.stringify({ name: "teste-issue-14", type: "release" }),
});
if (!created.ok)
  throw new Error(`Criar Flag: ${created.status} ${await created.text()}`);
const enabled = await fetch(
  `${server}/api/admin/projects/default/features/teste-issue-14/environments/production/on`,
  { method: "POST", headers: admin },
);
if (!enabled.ok)
  throw new Error(`Ativar Flag: ${enabled.status} ${await enabled.text()}`);
for (let i = 0; i < 40; i++) {
  const response = await fetch(`${edge}/api/frontend`, {
    headers: { authorization: required("UNLEASH_FRONTEND_TOKEN") },
  }).catch(() => null);
  if (response?.ok && (await response.text()).includes("teste-issue-14")) break;
  if (i === 39) throw new Error("Flag ausente no Edge");
  await Bun.sleep(1000);
}
console.log("Flag lida pelo Edge com token frontend OK");
const health = await fetch(`${edge}/internal-backstage/health`);
if (!health.ok) throw new Error(`Health Edge: ${health.status}`);
const client = Bun.spawnSync([
  "docker",
  "run",
  "--rm",
  "--network",
  required("TEST_NETWORK"),
  "-e",
  "UNLEASH_BACKEND_TOKEN",
  "-e",
  "TEST_SERVER",
  "--entrypoint",
  "node",
  required("TEST_SERVER_IMAGE"),
  "-e",
  `const { initialize } = require('unleash-client'); const u = initialize({url: 'http://' + process.env.TEST_SERVER + ':4242/api', appName: 'teste', customHeaders: {Authorization: process.env.UNLEASH_BACKEND_TOKEN}}); const timer = setTimeout(() => process.exit(2), 30000); u.on('synchronized', () => { clearTimeout(timer); const enabled = u.isEnabled('teste-issue-14'); u.destroy(); process.exit(enabled ? 0 : 1); });`,
]);
if (client.exitCode) throw new Error(`Backend: ${client.stderr.toString()}`);
console.log("Flag avaliada por container na rede com token backend OK");
for (const path of [
  "/api/admin/projects",
  "/auth/simple/login",
  "/",
  "/internal-backstage/tokens",
  "/internal-backstage/features",
]) {
  const response = await fetch(`${edge}${path}`, { redirect: "manual" });
  if (response.ok) throw new Error(`Admin respondeu no Edge: ${path}`);
}
console.log("Admin API e UI indisponíveis no Edge OK");
process.env.UNLEASH_TOKEN = required("UNLEASH_BACKEND_TOKEN");
process.env.UNLEASH_URL = `${server}/api`;
await configureFlags("teste");
const flags = OpenFeature.getClient();
async function waitFlag(expected: boolean) {
  for (let i = 0; i < 40; i++) {
    if ((await flags.getBooleanValue("teste-issue-14", !expected)) === expected)
      return;
    await Bun.sleep(1000);
  }
  throw new Error(
    `Flag ${expected ? "ligada" : "desligada"} não vista pelo OpenFeature`,
  );
}
await waitFlag(true);
const disabled = await fetch(
  `${server}/api/admin/projects/default/features/teste-issue-14/environments/production/off`,
  { method: "POST", headers: admin },
);
if (!disabled.ok) throw new Error(`Desativar Flag: ${disabled.status}`);
await waitFlag(false);
await OpenFeature.close();
console.log("Flag ligada e desligada vista pelo OpenFeature OK");
