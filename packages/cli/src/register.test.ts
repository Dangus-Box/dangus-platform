import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "./register";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dangus-register-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "dangus.config.ts"),
    `export default {name:'produto',apps:{api:{domain:'api.example.com'},web:{domain:'web.example.com'},mobile:{domain:'mobile.example.com'}},database:'sqlite',deployTimeoutSeconds:120}`,
  );
  const statePath = join(dir, "bws.json");
  const ops = Object.entries({
    ops__UMAMI_ADMIN_PASSWORD: "umami",
    ops__UNLEASH_ADMIN_PASSWORD: "unleash",
    platform__HEALTHCHECKS_API_KEY: "health",
    platform__CLOUDFLARE_ACCOUNT_ID: "account",
    platform__CLOUDFLARE_DNS_TOKEN: "dns",
    platform__CLOUDFLARE_R2_TOKEN: "kv",
  }).map(([key, value]) => ({ key, value, id: key }));
  await writeFile(statePath, JSON.stringify({ ops, prod: [], writes: 0 }));
  const bws = join(dir, "bws");
  await writeFile(
    bws,
    `#!/usr/bin/env bun
const path = ${JSON.stringify(statePath)};
const state = await Bun.file(path).json();
const args = process.argv.slice(2);
if (args[0] === 'project') console.log(JSON.stringify([{id:'ops',name:'ops'},{id:'prod',name:'prod'}]));
else if (args[1] === 'list') console.log(JSON.stringify(state[args[2]]));
else if (args[1] === 'create' && state.fail === args[2]) { delete state.fail; await Bun.write(path,JSON.stringify(state)); process.exit(1); }
else if (args[1] === 'create') { state[args[4]].push({key:args[2],value:args[3],id:args[2]}); state.writes++; await Bun.write(path,JSON.stringify(state)); }
else process.exit(1);
`,
  );
  await chmod(bws, 0o700);
  let connected = true;
  let pendingSessions = 0;
  let calls = 0;
  let writes = 0;
  const commands: string[] = [];
  type Row = {
    name: string;
    id: string;
    domain: string;
    content: string;
    tokenName: string;
    type: string;
    projects: string[];
    environment: string;
    timeout: number;
    channels: string;
    proxied: boolean;
  };
  const sites: Row[] = [];
  const tokens: Row[] = [];
  const checks: Row[] = [];
  const records: Row[] = [];
  const zones: { id: string; name: string; status?: string }[] = [
    { id: "zone", name: "example.com" },
  ];
  const zoneQueries: string[] = [];
  const zoneFailure: { status?: number; body?: unknown } = {};
  let zonePages = 1;
  const dnsPaths: string[] = [];
  let targets: string[] | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const body = async () => (await req.json()) as Row;
      if (path === "/umami/api/auth/login") {
        const credentials = (await req.json()) as {
          username: string;
          password: string;
        };
        if (
          credentials.username !== "admin" ||
          credentials.password !== "umami"
        )
          return new Response(null, { status: 401 });
        return Response.json({ token: "session" });
      }
      if (path === "/unleash/auth/simple/login") {
        const credentials = (await req.json()) as {
          username: string;
          password: string;
        };
        if (
          credentials.username !== "admin" ||
          credentials.password !== "unleash"
        )
          return new Response(null, { status: 401 });
        return new Response("{}", {
          headers: { "set-cookie": "session=ok; Path=/" },
        });
      }
      if (
        path.startsWith("/umami/") &&
        req.headers.get("authorization") !== "Bearer session"
      )
        return new Response(null, { status: 401 });
      if (
        path.startsWith("/unleash/") &&
        (req.headers.get("cookie") !== "session=ok" || pendingSessions-- > 0)
      )
        return new Response(null, { status: 401 });
      if (
        path.startsWith("/health/") &&
        req.headers.get("x-api-key") !== "health"
      )
        return new Response(null, { status: 401 });
      if (
        path.startsWith("/cf/") &&
        req.headers.get("authorization") !==
          (path.startsWith("/cf/zones") ? "Bearer dns" : "Bearer kv")
      )
        return new Response(null, { status: 401 });
      if (method !== "GET") writes++;
      if (path === "/umami/api/websites") {
        if (method === "GET")
          return Response.json({ data: sites, count: sites.length });
        const site = { ...(await body()), id: "website-id" };
        sites.push(site);
        return Response.json(site);
      }
      if (path === "/unleash/api/admin/user") return Response.json({});
      if (path.startsWith("/unleash/api/admin/api-tokens/"))
        return Response.json({
          tokens: tokens.filter(
            (t) =>
              t.tokenName === decodeURIComponent(path.split("/").pop() ?? ""),
          ),
        });
      if (path === "/unleash/api/admin/api-tokens") {
        const input = await body();
        if (input.projects.length !== 1 || input.projects[0] !== "default")
          return new Response("bad project scope", { status: 400 });
        const token = {
          ...input,
          secret: `default:production.${input.tokenName}`,
        };
        tokens.push(token);
        return Response.json(token);
      }
      if (path === "/health/api/v3/channels/")
        return Response.json({
          channels: [{ id: "telegram-id", kind: "telegram" }],
        });
      if (path === "/health/api/v3/checks/") {
        if (method === "GET") return Response.json({ checks });
        const check = {
          ...(await body()),
          uuid: `check-${checks.length}`,
          ping_url: `https://ping.example/${checks.length}`,
        };
        checks.push(check);
        return Response.json(check);
      }
      if (path === "/cf/zones") {
        zoneQueries.push(url.searchParams.get("name") ?? "");
        if (url.searchParams.get("account.id") !== "account")
          return new Response(null, { status: 403 });
        if (zoneFailure.status)
          return new Response(null, { status: zoneFailure.status });
        if (zoneFailure.body) return Response.json(zoneFailure.body);
        // With several pages, the match is only on the last one.
        const page = Number(url.searchParams.get("page") ?? 1);
        return Response.json({
          result:
            page === zonePages
              ? zones
                  .filter((zone) => zone.name === url.searchParams.get("name"))
                  .map((zone) => ({ status: "active", ...zone }))
              : [],
          result_info: { page, total_pages: zonePages },
        });
      }
      if (/^\/cf\/zones\/[^/]+\/dns_records$/.test(path)) {
        dnsPaths.push(path);
        if (method === "GET")
          return Response.json({
            result: records.filter(
              (r) => r.name === url.searchParams.get("name"),
            ),
          });
        const record = { ...(await body()), id: `dns-${records.length}` };
        records.push(record);
        return Response.json({ success: true, result: record });
      }
      if (path === "/cf/accounts/account/storage/kv/namespaces")
        return Response.json({
          result: [{ id: "ns", title: "dangus-uptime" }],
        });
      if (path.endsWith("/values/targets")) {
        if (method === "GET")
          return targets
            ? Response.json(targets)
            : new Response("", { status: 404 });
        targets = (await req.json()) as string[];
        return Response.json({ success: true });
      }
      return new Response(`unexpected ${method} ${path}`, { status: 500 });
    },
  });
  const base = `http://localhost:${server.port}`;
  const command = async (args: string[]) => {
    commands.push(args[0]);
    if (args[0] === "tailscale")
      return JSON.stringify({
        BackendState: connected ? "Running" : "Stopped",
        MagicDNSSuffix: "fake-tailnet.test",
      });
    const proc = Bun.spawn([bws, ...args.slice(1)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited) throw new Error("bws fake failed");
    return output;
  };
  const deps = {
    command,
    umami: `${base}/umami`,
    unleash: `${base}/unleash`,
    healthchecks: `${base}/health`,
    cloudflare: `${base}/cf`,
    dns: async () => ["192.0.2.1", "2001:db8::1"],
  };
  return {
    dir,
    deps,
    server,
    sites,
    tokens,
    checks,
    records,
    zones,
    zoneQueries,
    zoneFailure,
    paginateZones(pages: number) {
      zonePages = pages;
    },
    dnsPaths,
    get targets() {
      return targets;
    },
    get calls() {
      return calls;
    },
    get writes() {
      return writes;
    },
    commands,
    disconnect() {
      connected = false;
    },
    delayUnleashSession(requests: number) {
      pendingSessions = requests;
    },
    async seedProd(key: string, value: string) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.prod.push({ key, value, id: key });
      await writeFile(statePath, JSON.stringify(state));
    },
    async failBwsCreate(key: string) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, JSON.stringify({ ...state, fail: key }));
    },
    async bws() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
  };
}

test("Registration integrates services and a second run changes nothing", async () => {
  const f = await fixture();
  try {
    await register(f.dir, f.deps);
    expect(
      f.sites.map(({ name, domain, id }) => ({ name, domain, id })),
    ).toEqual([
      { name: "produto", domain: "web.example.com", id: "website-id" },
    ]);
    expect(f.tokens.map((t) => [t.type, t.projects, t.environment])).toEqual([
      ["client", ["default"], "production"],
      ["frontend", ["default"], "production"],
    ]);
    expect(f.tokens.map((t) => t.tokenName)).toEqual([
      "produto-backend",
      "produto-frontend",
    ]);
    expect(f.checks.map((c) => [c.name, c.timeout, c.channels])).toEqual([
      ["produto-backup", 86400, "telegram-id"],
      ["produto-restore", 604800, "telegram-id"],
    ]);
    expect(f.records).toHaveLength(6);
    expect(f.records.every((r) => r.proxied === false)).toBe(true);
    expect(f.records.map((r) => [r.name, r.type, r.content])).toEqual([
      ["api.example.com", "A", "192.0.2.1"],
      ["api.example.com", "AAAA", "2001:db8::1"],
      ["web.example.com", "A", "192.0.2.1"],
      ["web.example.com", "AAAA", "2001:db8::1"],
      ["mobile.example.com", "A", "192.0.2.1"],
      ["mobile.example.com", "AAAA", "2001:db8::1"],
    ]);
    expect(f.targets).toEqual([
      "https://analytics.dangus-box.com/api/heartbeat",
      "https://flags.dangus-box.com/internal-backstage/health",
      "https://api.example.com/ready",
      "https://web.example.com/",
    ]);
    const state = await f.bws();
    const values = Object.fromEntries(
      state.prod.map((s: { key: string; value: string }) => [s.key, s.value]),
    );
    expect(values.produto__UNLEASH_TOKEN).toBe(
      "default:production.produto-backend",
    );
    expect(values.produto__FLAGS_FRONTEND_TOKEN).toBe(
      "default:production.produto-frontend",
    );
    expect(values.produto__EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN).toBe(
      values.produto__FLAGS_FRONTEND_TOKEN,
    );
    expect(values.produto__EXPO_PUBLIC_UMAMI_WEBSITE_ID).toBe(
      values.produto__UMAMI_WEBSITE_ID,
    );
    expect(state.prod.map((s: { key: string }) => s.key).sort()).toEqual(
      [
        "produto__EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN",
        "produto__EXPO_PUBLIC_UMAMI_WEBSITE_ID",
        "produto__FLAGS_FRONTEND_TOKEN",
        "produto__HEALTHCHECKS_BACKUP_ID",
        "produto__HEALTHCHECKS_BACKUP_URL",
        "produto__HEALTHCHECKS_RESTORE_ID",
        "produto__HEALTHCHECKS_RESTORE_URL",
        "produto__DNS_API_A_ID",
        "produto__DNS_API_AAAA_ID",
        "produto__DNS_WEB_A_ID",
        "produto__DNS_WEB_AAAA_ID",
        "produto__DNS_MOBILE_A_ID",
        "produto__DNS_MOBILE_AAAA_ID",
        "produto__UMAMI_WEBSITE_ID",
        "produto__UNLEASH_TOKEN",
      ].sort(),
    );
    const writes = f.writes;
    const bwsWrites = state.writes;
    await register(f.dir, f.deps);
    expect(f.writes).toBe(writes);
    expect((await f.bws()).writes).toBe(bwsWrites);
  } finally {
    f.server.stop(true);
  }
});

test("disconnected Tailscale fails before any external operation", async () => {
  const f = await fixture();
  try {
    f.disconnect();
    await expect(register(f.dir, f.deps)).rejects.toThrow(
      "Tailscale is disconnected",
    );
    expect(f.calls).toBe(0);
    expect((await f.bws()).writes).toBe(0);
    expect(f.commands).toEqual(["tailscale"]);
  } finally {
    f.server.stop(true);
  }
});

test("conflicting DNS record is preserved and requires review", async () => {
  const f = await fixture();
  try {
    await register(f.dir, f.deps);
    f.records[0].proxied = true;
    const writes = f.writes;
    const bwsWrites = (await f.bws()).writes;
    await expect(register(f.dir, f.deps)).rejects.toThrow(
      "DNS api.example.com A differs",
    );
    expect(f.records[0].proxied).toBe(true);
    expect(f.writes).toBe(writes);
    expect((await f.bws()).writes).toBe(bwsWrites);
  } finally {
    f.server.stop(true);
  }
});

test("CLI rejects Registration without Tailscale before querying BWS", async () => {
  const f = await fixture();
  try {
    const tailscale = join(f.dir, "tailscale");
    await writeFile(
      tailscale,
      '#!/bin/sh\nprintf \'{"BackendState":"Stopped"}\'\n',
    );
    await chmod(tailscale, 0o700);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "register"],
      {
        cwd: f.dir,
        env: { ...process.env, PATH: `${f.dir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(error).toContain("Tailscale is disconnected");
    expect(f.calls).toBe(0);
    expect((await f.bws()).writes).toBe(0);
  } finally {
    f.server.stop(true);
  }
});

test("waits for the Unleash session to become valid after login", async () => {
  const f = await fixture();
  try {
    // Unleash 6.9.1 responds to login before persisting the session.
    f.delayUnleashSession(2);
    await register(f.dir, f.deps);
    expect(f.tokens).toHaveLength(2);
  } finally {
    f.server.stop(true);
  }
});

test("token created in Unleash without a BWS write is recovered on rerun", async () => {
  const f = await fixture();
  try {
    await f.failBwsCreate("produto__UNLEASH_TOKEN");
    await expect(register(f.dir, f.deps)).rejects.toThrow();
    await register(f.dir, f.deps);
    expect(f.tokens).toHaveLength(2);
    const values = Object.fromEntries(
      (await f.bws()).prod.map((s: { key: string; value: string }) => [
        s.key,
        s.value,
      ]),
    );
    expect(values.produto__UNLEASH_TOKEN).toBe(
      "default:production.produto-backend",
    );
  } finally {
    f.server.stop(true);
  }
});

test("manual BWS secret without matching registration prevents duplicate creation", async () => {
  for (const [key, created] of [
    ["produto__UMAMI_WEBSITE_ID", "sites"],
    ["produto__HEALTHCHECKS_BACKUP_URL", "checks"],
    ["produto__DNS_WEB_A_ID", "records"],
  ] as const) {
    const f = await fixture();
    try {
      await f.seedProd(key, "manual");
      await expect(register(f.dir, f.deps)).rejects.toThrow(key);
      const rows = f[created] as { name: string }[];
      if (created === "records")
        expect(rows.some((r) => r.name === "web.example.com")).toBe(false);
      else expect(rows).toHaveLength(0);
    } finally {
      f.server.stop(true);
    }
  }
});

for (const domain of [
  "example.com",
  "api.example.com",
  "example.com.br",
  "api.example.com.br",
])
  test(`discovers the Product zone for ${domain} without a zone ID secret`, async () => {
    const f = await fixture();
    try {
      const zoneName = domain.endsWith(".br")
        ? "example.com.br"
        : "example.com";
      f.zones.splice(0, f.zones.length, { id: "product-zone", name: zoneName });
      await writeFile(
        join(f.dir, "dangus.config.ts"),
        `export default {name:'produto',apps:{api:{domain:'${domain}'}},database:'sqlite',deployTimeoutSeconds:120}`,
      );
      await register(f.dir, f.deps);
      expect(f.zoneQueries.at(-1)).toBe(zoneName);
      expect(
        f.dnsPaths.every(
          (path) => path === "/cf/zones/product-zone/dns_records",
        ),
      ).toBe(true);
      expect(f.records.map((r) => r.name)).toEqual([domain, domain]);
    } finally {
      f.server.stop(true);
    }
  });

test("uses the longest existing suffix rather than a parent zone", async () => {
  const f = await fixture();
  try {
    f.zones.push({ id: "app-zone", name: "api.example.com" });
    await register(f.dir, f.deps);
    expect(f.dnsPaths[0]).toBe("/cf/zones/app-zone/dns_records");
    expect(f.zoneQueries[0]).toBe("api.example.com");
  } finally {
    f.server.stop(true);
  }
});

test("missing zone gives actionable guidance without DNS writes", async () => {
  const f = await fixture();
  try {
    f.zones.splice(0);
    await expect(register(f.dir, f.deps)).rejects.toThrow(
      "Add and activate the Product zone in this account",
    );
    expect(f.records).toEqual([]);
    expect(f.dnsPaths).toEqual([]);
  } finally {
    f.server.stop(true);
  }
});

for (const conflict of [
  "CNAME",
  "proxied",
  "different IPv4",
  "different IPv6",
  "duplicate",
])
  test(`preflights all Apps and preserves DNS on ${conflict}`, async () => {
    const f = await fixture();
    try {
      await register(f.dir, f.deps);
      // Leave the first App missing so a later conflict would expose partial writes.
      f.records.splice(0, 2);
      const record = f.records[conflict === "different IPv6" ? 1 : 0];
      if (conflict === "CNAME") record.type = "CNAME";
      if (conflict === "proxied") record.proxied = true;
      if (conflict.startsWith("different"))
        record.content = "conflicting-address";
      if (conflict === "duplicate") f.records.push({ ...record });
      // The missing records' BWS secrets would otherwise block the preflight early.
      // Keep the real fixture vault but remove only the first App DNS IDs.
      const statePath = join(f.dir, "bws.json");
      const state = await f.bws();
      state.prod = state.prod.filter(
        (s: { key: string }) => !s.key.startsWith("produto__DNS_API_"),
      );
      await writeFile(statePath, JSON.stringify(state));
      const before = structuredClone(f.records);
      await expect(register(f.dir, f.deps)).rejects.toThrow(
        "DNS web.example.com",
      );
      expect(f.records).toEqual(before);
    } finally {
      f.server.stop(true);
    }
  });

test("zone discovery follows /zones pagination", async () => {
  const f = await fixture();
  try {
    f.paginateZones(3);
    await register(f.dir, f.deps);
    expect(f.records).toHaveLength(6);
    expect(f.dnsPaths.every((p) => p === "/cf/zones/zone/dns_records")).toBe(
      true,
    );
  } finally {
    f.server.stop(true);
  }
});

for (const failure of [
  { status: 403 },
  { status: 500 },
  { body: { success: false, errors: [{ code: 9109 }] } },
])
  test(`zone API failure ${JSON.stringify(failure)} stops before DNS writes`, async () => {
    const f = await fixture();
    try {
      Object.assign(f.zoneFailure, failure);
      await expect(register(f.dir, f.deps)).rejects.toThrow();
      expect(f.dnsPaths).toEqual([]);
      expect(f.records).toEqual([]);
    } finally {
      f.server.stop(true);
    }
  });

for (const status of ["pending", "initializing", "moved"])
  test(`${status} zone is not written and asks for activation`, async () => {
    const f = await fixture();
    try {
      f.zones[0].status = status;
      await expect(register(f.dir, f.deps)).rejects.toThrow(
        `Cloudflare zone example.com is ${status}`,
      );
      expect(f.dnsPaths).toEqual([]);
      expect(f.records).toEqual([]);
    } finally {
      f.server.stop(true);
    }
  });

test("pending sub-zone does not fall back to its active parent", async () => {
  const f = await fixture();
  try {
    f.zones.push({
      id: "app-zone",
      name: "api.example.com",
      status: "pending",
    });
    await expect(register(f.dir, f.deps)).rejects.toThrow(
      "Cloudflare zone api.example.com is pending",
    );
    expect(f.records).toEqual([]);
  } finally {
    f.server.stop(true);
  }
});

test("parent zone and sub-zone in the account each get their own records", async () => {
  const f = await fixture();
  try {
    f.zones.push({ id: "app-zone", name: "api.example.com" });
    await register(f.dir, f.deps);
    const byPath = (path: string) =>
      f.dnsPaths.filter((p) => p === path).length;
    // api: one GET + A + AAAA in the sub-zone; web and mobile in the parent.
    expect(byPath("/cf/zones/app-zone/dns_records")).toBe(3);
    expect(byPath("/cf/zones/zone/dns_records")).toBe(6);
    expect(f.zoneQueries.slice(0, 2)).toEqual([
      "api.example.com",
      "web.example.com",
    ]);
  } finally {
    f.server.stop(true);
  }
});

test("apex and com.br domains rerun without writes when records match", async () => {
  const f = await fixture();
  try {
    f.zones.push({ id: "br-zone", name: "example.com.br" });
    await writeFile(
      join(f.dir, "dangus.config.ts"),
      `export default {name:'produto',apps:{api:{domain:'Example.com'},web:{domain:'web.example.com.br'}},database:'sqlite',deployTimeoutSeconds:120}`,
    );
    await register(f.dir, f.deps);
    expect(f.records.map((r) => [r.name, r.type])).toEqual([
      ["example.com", "A"],
      ["example.com", "AAAA"],
      ["web.example.com.br", "A"],
      ["web.example.com.br", "AAAA"],
    ]);
    const writes = f.writes;
    const bwsWrites = (await f.bws()).writes;
    await register(f.dir, f.deps);
    expect(f.writes).toBe(writes);
    expect((await f.bws()).writes).toBe(bwsWrites);
  } finally {
    f.server.stop(true);
  }
});

test("apex keeps unrelated MX/TXT records and adds only A/AAAA", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.dir, "dangus.config.ts"),
      `export default {name:'produto',apps:{api:{domain:'example.com'}},database:'sqlite',deployTimeoutSeconds:120}`,
    );
    for (const type of ["MX", "TXT"])
      f.records.push({
        name: "example.com",
        type,
        content: "mail",
        id: `dns-${type}`,
        proxied: false,
      } as (typeof f.records)[number]);
    await register(f.dir, f.deps);
    expect(f.records.map((r) => r.type)).toEqual(["MX", "TXT", "A", "AAAA"]);
  } finally {
    f.server.stop(true);
  }
});
