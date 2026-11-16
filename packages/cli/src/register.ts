import { resolve4, resolve6 } from "node:dns/promises";
import { loadConfig, type ResolvedProductConfig } from "./config";

type Command = (args: string[]) => Promise<string>;
type Dependencies = {
  command?: Command;
  fetch?: typeof fetch;
  dns?: (host: string) => Promise<string[]>;
  umami?: string;
  unleash?: string;
  healthchecks?: string;
  cloudflare?: string;
};

type Secret = { id: string; key: string; value: string };
function parseBws(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Resposta inválida do BWS.");
  }
}
const defaultTargets = [
  "https://analytics.dangus-box.com/api/heartbeat",
  "https://flags.dangus-box.com/internal-backstage/health",
];

async function command(args: string[]): Promise<string> {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`Falha ao executar ${args[0]}.`);
  return stdout;
}

async function tailscale(run: Command): Promise<string> {
  try {
    const status = JSON.parse(await run(["tailscale", "status", "--json"]));
    if (status.BackendState !== "Running" || !status.MagicDNSSuffix)
      throw new Error();
    return status.MagicDNSSuffix;
  } catch {
    throw new Error("Tailscale desconectado: conecte-o antes do Registro.");
  }
}

function one<T>(items: T[], description: string): T | undefined {
  if (items.length > 1)
    throw new Error(`${description}: registros duplicados.`);
  return items[0];
}

async function secrets(run: Command) {
  const projects = parseBws(await run(["bws", "project", "list"])) as {
    id: string;
    name: string;
  }[];
  const project = (name: string) => {
    const found = one(
      projects.filter((p) => p.name === name),
      `Projeto ${name}`,
    );
    if (!found) throw new Error(`Projeto ${name} ausente no BWS.`);
    return found.id;
  };
  const opsId = project("ops");
  const prodId = project("prod");
  const ops = parseBws(await run(["bws", "secret", "list", opsId])) as Secret[];
  const prod = parseBws(
    await run(["bws", "secret", "list", prodId]),
  ) as Secret[];
  const get = (list: Secret[], key: string) =>
    one(
      list.filter((secret) => secret.key === key),
      `Secret ${key}`,
    )?.value;
  const required = (key: string) => {
    const value = get(ops, key);
    if (!value) throw new Error(`Secret ${key} ausente no BWS.`);
    return value;
  };
  async function save(
    list: Secret[],
    projectId: string,
    key: string,
    value: string,
  ) {
    if (!value) throw new Error(`Valor ausente para ${key}.`);
    const existing = get(list, key);
    if (existing !== undefined) {
      if (existing !== value) throw new Error(`Secret ${key} diverge no BWS.`);
      return;
    }
    await run(["bws", "secret", "create", key, value, projectId, "-o", "none"]);
    list.push({ id: "", key, value });
  }
  return {
    required,
    prod: (key: string) => get(prod, key),
    saveProd: (key: string, value: string) => save(prod, prodId, key, value),
  };
}

async function api(
  request: typeof fetch,
  base: string,
  path: string,
  options: RequestInit = {},
) {
  let response: Response;
  try {
    response = await request(`${base}${path}`, options);
  } catch {
    throw new Error(`Falha de conexão com ${new URL(base).host}.`);
  }
  if (!response.ok)
    throw new Error(
      `Falha na API ${new URL(base).host}: HTTP ${response.status}.`,
    );
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    throw new Error(`Resposta inválida da API ${new URL(base).host}.`);
  }
}
const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

async function unleashLogin(
  request: typeof fetch,
  base: string,
  password: string,
) {
  const response = await request(`${base}/auth/simple/login`, {
    ...json({ username: "admin", password }),
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!response.ok || !cookie)
    throw new Error("Falha ao autenticar no Unleash.");
  // O Unleash responde ao login antes de persistir a sessão.
  for (let attempt = 0; attempt < 20; attempt++) {
    const user = await request(`${base}/api/admin/user`, {
      headers: { cookie },
    });
    if (user.ok) return { cookie, "content-type": "application/json" };
    await Bun.sleep(250);
  }
  throw new Error("Falha ao autenticar no Unleash.");
}

export async function register(root: string, deps: Dependencies = {}) {
  const run = deps.command ?? command;
  const suffix = await tailscale(run);
  const config = await loadConfig(root);
  await registerProduct(config, suffix, deps, run);
}

async function registerProduct(
  config: ResolvedProductConfig,
  suffix: string,
  deps: Dependencies,
  run: Command,
) {
  const vault = await secrets(run);
  const request = deps.fetch ?? fetch;
  const umami = deps.umami ?? "https://analytics.dangus-box.com";
  const unleash = deps.unleash ?? `https://flags-admin.${suffix}`;
  const health = deps.healthchecks ?? "https://healthchecks.io";
  const cf = deps.cloudflare ?? "https://api.cloudflare.com/client/v4";
  const key = (name: string) => `${config.name}__${name}`;
  const save = (name: string, value: string) =>
    vault.saveProd(key(name), value);
  const login = await api(
    request,
    umami,
    "/api/auth/login",
    json({
      username: "admin",
      password: vault.required("ops__UMAMI_ADMIN_PASSWORD"),
    }),
  );
  const umamiHeaders = {
    authorization: `Bearer ${login.token}`,
    "content-type": "application/json",
  };
  if (config.apps.web) {
    const sites: { id: string; name: string; domain: string }[] = [];
    for (let page = 1; ; page++) {
      const result = await api(
        request,
        umami,
        `/api/websites?page=${page}&pageSize=100`,
        { headers: umamiHeaders },
      );
      sites.push(...result.data);
      if (sites.length >= result.count) break;
      if (!result.data.length) throw new Error("Paginação do Umami inválida.");
    }
    let website = one(
      sites.filter((s) => s.name === config.name),
      "Website Umami",
    ) as { id: string; domain: string } | undefined;
    if (website && website.domain !== config.apps.web.domain)
      throw new Error("Domínio do website Umami diverge da Config do Produto.");
    if (!website)
      website = await api(request, umami, "/api/websites", {
        ...json({ name: config.name, domain: config.apps.web.domain }),
        headers: umamiHeaders,
      });
    if (!website) throw new Error("Website Umami ausente.");
    await save("UMAMI_WEBSITE_ID", website.id);
    if (config.apps.mobile)
      await save("EXPO_PUBLIC_UMAMI_WEBSITE_ID", website.id);
  }
  const uh = await unleashLogin(
    request,
    unleash,
    vault.required("ops__UNLEASH_ADMIN_PASSWORD"),
  );
  for (const [type, secretName] of [
    ["client", "UNLEASH_TOKEN"],
    ["frontend", "FLAGS_FRONTEND_TOKEN"],
  ] as const) {
    const tokenName = `${config.name}-${type === "client" ? "backend" : "frontend"}`;
    const tokens = (
      await api(
        request,
        unleash,
        `/api/admin/api-tokens/${encodeURIComponent(tokenName)}`,
        { headers: uh },
      )
    ).tokens;
    const token = one(tokens, "Token Unleash") as
      | {
          type: string;
          projects: string[];
          environment: string;
          secret: string;
        }
      | undefined;
    if (
      token &&
      (token.type !== type ||
        token.environment !== "production" ||
        token.projects.length !== 1 ||
        token.projects[0] !== "default")
    )
      throw new Error(`Token ${tokenName} diverge da configuração esperada.`);
    if (!token && vault.prod(key(secretName)))
      throw new Error(`Token ${tokenName} ausente no Unleash.`);
    const value =
      token?.secret ??
      (
        await api(request, unleash, "/api/admin/api-tokens", {
          ...json({
            tokenName,
            type,
            environment: "production",
            projects: ["default"],
          }),
          headers: uh,
        })
      ).secret;
    await save(secretName, value);
    if (type === "frontend" && config.apps.mobile)
      await save("EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN", value);
  }
  const hh = {
    "X-Api-Key": vault.required("platform__HEALTHCHECKS_API_KEY"),
    "content-type": "application/json",
  };
  const channels = (
    await api(request, health, "/api/v3/channels/", { headers: hh })
  ).channels;
  const telegram = channels.filter(
    (c: { kind: string }) => c.kind === "telegram",
  );
  if (!telegram.length)
    throw new Error("Integração Telegram ausente no Healthchecks.");
  const checks = (
    await api(request, health, "/api/v3/checks/", { headers: hh })
  ).checks;
  for (const [kind, timeout] of [
    ["backup", 86400],
    ["restore", 604800],
  ] as const) {
    const name = `${config.name}-${kind}`;
    let check = one(
      checks.filter((c: { name: string }) => c.name === name),
      `Check ${name}`,
    ) as
      | { uuid: string; ping_url: string; timeout: number; channels: string }
      | undefined;
    if (
      check &&
      (check.timeout !== timeout ||
        telegram.some(
          (c: { id: string }) => !check?.channels.split(",").includes(c.id),
        ))
    )
      throw new Error(`Check ${name} diverge da configuração esperada.`);
    if (!check)
      check = await api(request, health, "/api/v3/checks/", {
        ...json({
          name,
          timeout,
          channels: telegram.map((c: { id: string }) => c.id).join(","),
        }),
        headers: hh,
      });
    if (!check?.ping_url || !check.uuid)
      throw new Error(`ID ou ping URL ausente: ${name}.`);
    await save(`HEALTHCHECKS_${kind.toUpperCase()}_ID`, check.uuid);
    await save(`HEALTHCHECKS_${kind.toUpperCase()}_URL`, check.ping_url);
  }
  const zone = vault.required("platform__CLOUDFLARE_ZONE_ID");
  const account = vault.required("platform__CLOUDFLARE_ACCOUNT_ID");
  const dnsHeaders = {
    authorization: `Bearer ${vault.required("platform__CLOUDFLARE_DNS_TOKEN")}`,
    "content-type": "application/json",
  };
  const kvHeaders = {
    authorization: `Bearer ${vault.required("platform__CLOUDFLARE_R2_TOKEN")}`,
    "content-type": "application/json",
  };
  async function cloudflareList<T>(
    path: string,
    headers: Record<string, string>,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const result = await api(request, cf, `${path}&page=${page}`, {
        headers,
      });
      if (result.success === false || !Array.isArray(result.result))
        throw new Error("Resposta de listagem Cloudflare inválida.");
      items.push(...result.result);
      if (page >= (result.result_info?.total_pages ?? 1)) return items;
    }
  }
  const addresses = await (
    deps.dns ??
    (async (host) => [...(await resolve4(host)), ...(await resolve6(host))])
  )("analytics.dangus-box.com");
  for (const [appName, app] of Object.entries(config.apps))
    if (app) {
      for (const type of ["A", "AAAA"] as const) {
        const address = addresses.find((ip) =>
          type === "AAAA" ? ip.includes(":") : !ip.includes(":"),
        );
        if (!address) throw new Error(`Endereço ${type} da Stack Ops ausente.`);
        const path = `/zones/${zone}/dns_records`;
        const records = await cloudflareList<{
          id: string;
          content: string;
          proxied: boolean;
        }>(
          `${path}?type=${type}&name=${encodeURIComponent(app.domain)}&per_page=100`,
          dnsHeaders,
        );
        let record = one(records, `DNS ${app.domain} ${type}`) as
          | { id: string; content: string; proxied: boolean }
          | undefined;
        if (record && (record.content !== address || record.proxied))
          throw new Error(`DNS ${app.domain} ${type} diverge da Stack Ops.`);
        if (!record) {
          const created = await api(request, cf, path, {
            ...json({
              type,
              name: app.domain,
              content: address,
              proxied: false,
            }),
            headers: dnsHeaders,
          });
          if (created.success === false)
            throw new Error("Falha ao criar registro DNS.");
          record = created.result;
        }
        if (!record?.id) throw new Error(`ID DNS ausente para ${app.domain}.`);
        await save(`DNS_${appName.toUpperCase()}_${type}_ID`, record.id);
      }
    }
  const namespaces = await cloudflareList<{ id: string; title: string }>(
    `/accounts/${account}/storage/kv/namespaces?per_page=100`,
    kvHeaders,
  );
  const namespace = one(
    namespaces.filter((n: { title: string }) => n.title === "dangus-uptime"),
    "KV uptime",
  ) as { id: string } | undefined;
  if (!namespace) throw new Error("Namespace KV dangus-uptime ausente.");
  const path = `/accounts/${account}/storage/kv/namespaces/${namespace.id}/values/targets`;
  const response = await request(`${cf}${path}`, { headers: kvHeaders });
  if (!response.ok && response.status !== 404)
    throw new Error(`Falha ao ler destinos KV: HTTP ${response.status}.`);
  const previous: string[] =
    response.status === 404 ? defaultTargets : await response.json();
  if (
    !Array.isArray(previous) ||
    !previous.every((url) => typeof url === "string")
  )
    throw new Error("Lista de destinos KV inválida.");
  const targets = [...previous];
  for (const url of [
    config.apps.api && `https://${config.apps.api.domain}/ready`,
    config.apps.web && `https://${config.apps.web.domain}/`,
  ])
    if (url && !targets.includes(url)) targets.push(url);
  if (targets.length !== previous.length) {
    const result = await request(`${cf}${path}`, {
      method: "PUT",
      headers: kvHeaders,
      body: JSON.stringify(targets),
    });
    if (!result.ok)
      throw new Error(`Falha ao gravar destinos KV: HTTP ${result.status}.`);
    if (!(await result.json()).success)
      throw new Error("Falha ao gravar destinos KV.");
  }
}
