// Registro contra Unleash 6.9.1 e Umami 2.19 reais; Healthchecks, Cloudflare,
// BWS e Tailscale são simulados. Iniciado por register-e2e.sh.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../../../packages/cli/src/register";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ausente`);
  return value;
};
const unleash = env("UNLEASH_URL");
const umami = env("UMAMI_URL");
const edge = env("EDGE_URL");

type Secret = { id: string; key: string; value: string };
const vault: Record<string, Secret[]> = {
  ops: Object.entries({
    ops__UMAMI_ADMIN_PASSWORD: env("UMAMI_ADMIN_PASSWORD"),
    ops__UNLEASH_ADMIN_PASSWORD: env("UNLEASH_ADMIN_PASSWORD"),
    platform__HEALTHCHECKS_API_KEY: "health",
    platform__CLOUDFLARE_ZONE_ID: "zone",
    platform__CLOUDFLARE_ACCOUNT_ID: "account",
    platform__CLOUDFLARE_DNS_TOKEN: "dns",
    platform__CLOUDFLARE_R2_TOKEN: "kv",
  }).map(([key, value]) => ({ id: key, key, value })),
  prod: [],
};
let bwsWrites = 0;
let failBwsCreate = false;
async function command(args: string[]) {
  if (args[0] === "tailscale")
    return JSON.stringify({
      BackendState: "Running",
      MagicDNSSuffix: "tail.test",
    });
  if (args[0] === "bws" && args[1] === "project")
    return JSON.stringify([
      { id: "ops", name: "ops" },
      { id: "prod", name: "prod" },
    ]);
  if (args[0] === "bws" && args[2] === "list")
    return JSON.stringify(vault[args[3] as string]);
  if (args[0] === "bws" && args[2] === "create") {
    if (failBwsCreate) throw new Error("Falha ao executar bws.");
    bwsWrites++;
    vault[args[5] as string]?.push({
      id: args[3] as string,
      key: args[3] as string,
      value: args[4] as string,
    });
    return "";
  }
  throw new Error(`comando inesperado: ${args.slice(0, 3).join(" ")}`);
}

const realWrites = { unleash: 0, umami: 0 };
const fakeChecks: Record<string, unknown>[] = [];
const fakeRecords: Record<string, unknown>[] = [];
let targets: string[] | undefined;
const fake = "http://fake.test";
const request = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = url.origin;
  if (base === new URL(unleash).origin || base === new URL(umami).origin) {
    if (method !== "GET" && !url.pathname.endsWith("/login"))
      realWrites[base === new URL(unleash).origin ? "unleash" : "umami"]++;
    return fetch(input, init);
  }
  const body = () => JSON.parse(String(init?.body));
  const path = url.pathname;
  if (path.endsWith("/channels/"))
    return Response.json({ channels: [{ id: "tg", kind: "telegram" }] });
  if (path.endsWith("/checks/")) {
    if (method === "GET") return Response.json({ checks: fakeChecks });
    const check = {
      ...body(),
      uuid: `c${fakeChecks.length}`,
      ping_url: `https://hc.test/${fakeChecks.length}`,
    };
    fakeChecks.push(check);
    return Response.json(check);
  }
  if (path.endsWith("/dns_records")) {
    if (method === "GET")
      return Response.json({
        result: fakeRecords.filter(
          (r) =>
            r.type === url.searchParams.get("type") &&
            r.name === url.searchParams.get("name"),
        ),
      });
    const record = { ...body(), id: `d${fakeRecords.length}` };
    fakeRecords.push(record);
    return Response.json({ success: true, result: record });
  }
  if (path.endsWith("/namespaces"))
    return Response.json({ result: [{ id: "ns", title: "dangus-uptime" }] });
  if (path.endsWith("/values/targets")) {
    if (method === "GET")
      return targets
        ? Response.json(targets)
        : new Response(null, { status: 404 });
    targets = JSON.parse(String(init?.body));
    return Response.json({ success: true });
  }
  return new Response(null, { status: 500 });
}) as typeof fetch;

async function product(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `register-${name}-`));
  await writeFile(
    join(dir, "dangus.config.ts"),
    `export default {name:'${name}',apps:{api:{domain:'api.${name}.test'},web:{domain:'web.${name}.test'}},database:'sqlite',deployTimeoutSeconds:120}`,
  );
  return dir;
}
const deps = {
  command,
  fetch: request,
  umami,
  unleash,
  healthchecks: fake,
  cloudflare: fake,
  dns: async () => ["192.0.2.1", "2001:db8::1"],
};
const prod = (key: string) => vault.prod?.find((s) => s.key === key)?.value;

// Falha parcial: Umami e Unleash gravados, BWS indisponível depois disso.
const alpha = await product("alpha");
failBwsCreate = true;
await register(alpha, deps).then(
  () => {
    throw new Error("Registro deveria falhar com BWS indisponível");
  },
  () => {},
);
failBwsCreate = false;
await register(alpha, deps);
console.log("Reexecução após falha parcial do BWS OK");

const before = { ...realWrites, bws: bwsWrites };
await register(alpha, deps);
if (
  realWrites.unleash !== before.unleash ||
  realWrites.umami !== before.umami ||
  bwsWrites !== before.bws
)
  throw new Error(
    `Segunda execução gravou: ${JSON.stringify({ before, realWrites, bwsWrites })}`,
  );
console.log("Segunda execução sem gravações em Unleash, Umami e BWS OK");

const login = await fetch(`${unleash}/auth/simple/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "admin",
    password: env("UNLEASH_ADMIN_PASSWORD"),
  }),
});
const admin = {
  "content-type": "application/json",
  cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
};
while (!(await fetch(`${unleash}/api/admin/user`, { headers: admin })).ok)
  await Bun.sleep(250);
const tokens = (await (
  await fetch(`${unleash}/api/admin/api-tokens`, { headers: admin })
).json()) as { tokens: { tokenName: string }[] };
const names = tokens.tokens
  .map((t) => t.tokenName)
  .filter((n) => /^alpha/.test(n));
if (names.sort().join() !== "alpha-backend,alpha-frontend")
  throw new Error(`Tokens Unleash: ${names}`);
console.log("Tokens backend e frontend únicos no Unleash OK");

const sites = (await (
  await fetch(`${umami}/api/websites`, {
    headers: {
      authorization: `Bearer ${
        (
          (await (
            await fetch(`${umami}/api/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                username: "admin",
                password: env("UMAMI_ADMIN_PASSWORD"),
              }),
            })
          ).json()) as { token: string }
        ).token
      }`,
    },
  })
).json()) as { data: { id: string; name: string; domain: string }[] };
const site = sites.data.filter((s) => s.name === "alpha");
if (site.length !== 1 || site[0]?.id !== prod("alpha__UMAMI_WEBSITE_ID"))
  throw new Error(`Websites Umami: ${JSON.stringify(sites.data)}`);
console.log("Website Umami único e ID gravado no BWS OK");

await register(await product("beta"), deps);
for (const [name, app] of [
  ["alpha.secreta", "alpha"],
  ["beta.secreta", "beta"],
]) {
  const path = `${unleash}/api/admin/projects/default/features`;
  const created = await fetch(path, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name, type: "release" }),
  });
  if (!created.ok) throw new Error(`Criar Flag: ${created.status}`);
  const strategy = await fetch(
    `${path}/${name}/environments/production/strategies`,
    {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        name: "flexibleRollout",
        parameters: { rollout: "100", stickiness: "default", groupId: name },
        constraints: [
          { contextName: "appName", operator: "IN", values: [app] },
        ],
      }),
    },
  );
  if (!strategy.ok) throw new Error(`Estratégia: ${strategy.status}`);
  const on = await fetch(`${path}/${name}/environments/production/on`, {
    method: "POST",
    headers: admin,
  });
  if (!on.ok) throw new Error(`Ativar Flag: ${on.status}`);
}
async function visible(product: string) {
  const token = prod(`${product}__FLAGS_FRONTEND_TOKEN`) ?? "";
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${edge}/api/frontend?appName=${product}`, {
      headers: { authorization: token },
    }).catch(() => null);
    const names = response?.ok
      ? (
          (await response.json()) as { toggles: { name: string }[] }
        ).toggles.map((t) => t.name)
      : [];
    if (names.length) return names;
    await Bun.sleep(1000);
  }
  return [];
}
const alphaFlags = await visible("alpha");
const betaFlags = await visible("beta");
if (
  alphaFlags.join() !== "alpha.secreta" ||
  betaFlags.join() !== "beta.secreta"
)
  throw new Error(`Edge: alpha=${alphaFlags} beta=${betaFlags}`);
console.log("Edge mostra a cada token frontend só as Flags do seu appName OK");
