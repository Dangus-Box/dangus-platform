import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig } from "./config";
import {
  backupNow,
  deploy,
  KAMAL_IMAGE,
  productVersion,
  type Runner,
  render,
  resolveDomain,
  withRendered,
} from "./deploy";

const root = resolve(import.meta.dir, "../../..");
const agePublicKey =
  "age1pcr7wevcd3r75uannynawa9epy74qd2p2d63kuuge6rt2yuld5wqkuq3mw";
const backupBws = [
  { key: "ops__BACKUP_AGE_PUBLIC_KEY", value: agePublicKey },
  { key: "ops__R2_BACKUP_ACCESS_KEY_ID", value: "access" },
  { key: "ops__R2_BACKUP_SECRET_ACCESS_KEY", value: "secret" },
  { key: "platform__R2_ENDPOINT", value: "https://example.com" },
  {
    key: "produto__HEALTHCHECKS_BACKUP_URL",
    value: "https://example.com/check",
  },
];
for (const variant of ["postgres", "sqlite"]) {
  test(`${variant} render matches golden files`, async () => {
    const product = join(root, "examples", variant);
    const config = await loadConfig(product);
    await withRendered(
      config,
      "devbox-1",
      async (dir, apps) => {
        expect(apps).toEqual(["api", "web"]);
        for (const app of apps) {
          for (const [source, suffix] of [
            ["deploy.yml", "yml"],
            [".kamal/secrets", "secrets"],
          ]) {
            expect(await readFile(join(dir, app, source), "utf8")).toBe(
              await readFile(
                join(
                  root,
                  "packages/cli/test/golden",
                  `${variant}-${app}.${suffix}`,
                ),
                "utf8",
              ),
            );
          }
        }
      },
      ".",
      ["192.0.2.1", "2001:db8::1"],
    );
    const cli = Bun.spawn(
      ["bun", join(root, "packages/cli/src/index.ts"), "render"],
      {
        cwd: product,
        env: { ...process.env, DANGUS_PROXY_BIND_IPS: "192.0.2.1,2001:db8::1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);
    expect(output).toContain(
      (
        await readFile(
          join(root, "packages/cli/test/golden", `${variant}-api.yml`),
          "utf8",
        )
      ).replaceAll(
        "\"<%= ENV.fetch('KAMAL_VERSION') %>\"",
        await productVersion(),
      ),
    );
    expect(output).toContain(
      (
        await readFile(
          join(root, "packages/cli/test/golden", `${variant}-web.yml`),
          "utf8",
        )
      ).replaceAll(
        "\"<%= ENV.fetch('KAMAL_VERSION') %>\"",
        await productVersion(),
      ),
    );
  });
}

test("deploy passes secrets only through the environment and uses exact commands", async () => {
  const config = validateConfig({
    name: "produto",
    apps: {
      api: { domain: "api.produto.com", secrets: ["TOKEN"] },
      web: { domain: "web.produto.com" },
    },
    database: "postgres",
    deployTimeoutSeconds: 42,
  });
  const calls: string[][] = [];
  let temp = "";
  const runner: Runner = async (args, env) => {
    calls.push(args);
    if (args[0] === "git") return { code: 0, stdout: "a".repeat(40) };
    if (args[0] === "bws")
      return {
        code: 0,
        stdout: JSON.stringify([
          { key: "produto__TOKEN", value: "secret-value" },
          { key: "produto__POSTGRES_PASSWORD", value: "secret-password" },
          ...backupBws,
        ]),
      };
    expect(env.TOKEN).toBe("secret-value");
    expect(env.AGE_PUBLIC_KEY).toBe(agePublicKey);
    expect(env.DATABASE_URL).toBe(
      "postgres://produto:secret-password@produto-api-db:5432/produto",
    );
    temp = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    const configPath = join(temp, "deploy.yml");
    const files =
      (await readFile(configPath, "utf8")) +
      (await readFile(join(temp, ".kamal/secrets"), "utf8"));
    expect(files).not.toContain("secret-value");
    expect(files).not.toContain("secret-password");
    if (args.includes("/dangus/deploy.yml") && files.includes("backup:"))
      expect(files).toContain("AGE_PUBLIC_KEY=$AGE_PUBLIC_KEY");
    return { code: 0, stdout: "" };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
    DANGUS_PROXY_BIND_IPS: "192.0.2.1",
    KAMAL_REGISTRY_USERNAME: "user",
    KAMAL_REGISTRY_PASSWORD: "secret-registry",
  });
  expect(calls[0]).toEqual(["git", "rev-parse", "--verify", "HEAD"]);
  expect(calls[1]).toEqual(["bws", "secret", "list"]);
  for (const [index, app] of ["api", "web"].entries()) {
    const args = calls[index + 2];
    const path = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    expect(args).toEqual([
      "docker",
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      "/produto:/produto",
      "-w",
      "/produto",
      "-v",
      `${path}:/dangus:ro`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      "/ssh-agent:/ssh-agent",
      "-e",
      "SSH_AUTH_SOCK=/ssh-agent",
      "-e",
      "KAMAL_REGISTRY_USERNAME",
      "-e",
      "KAMAL_REGISTRY_PASSWORD",
      ...(app === "api"
        ? [
            "-e",
            "TOKEN",
            "-e",
            "POSTGRES_PASSWORD",
            "-e",
            "DATABASE_URL",
            ...[
              "R2_ACCESS_KEY_ID",
              "R2_SECRET_ACCESS_KEY",
              "R2_ENDPOINT",
              "HEALTHCHECKS_URL",
              "AGE_PUBLIC_KEY",
            ].flatMap((name) => ["-e", name]),
          ]
        : []),
      KAMAL_IMAGE,
      "setup",
      "--config-file",
      "/dangus/deploy.yml",
      `--version=${"a".repeat(40)}`,
    ]);
  }
  expect(JSON.stringify(calls)).not.toContain("secret-password");
  expect(JSON.stringify(calls)).not.toContain("secret-value");
  expect(JSON.stringify(calls)).not.toContain("secret-registry");
  expect(await Bun.file(join(temp, "deploy.yml")).exists()).toBe(false);
});

test("missing secret stops deploy before calling Docker", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com", secrets: ["TOKEN"] } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: args[0] === "git" ? "a".repeat(40) : "[]" };
  };
  await expect(
    deploy(config, "/produto", runner, {
      SSH_AUTH_SOCK: "/ssh-agent",
      DANGUS_PROXY_BIND_IPS: "192.0.2.1",
    }),
  ).rejects.toThrow("produto__TOKEN");
  expect(calls).toEqual([
    ["git", "rev-parse", "--verify", "HEAD"],
    ["bws", "secret", "list"],
  ]);
});

test("DANGUS_HOST overrides the default Host devbox-1", async () => {
  const cli = Bun.spawn(
    ["bun", join(root, "packages/cli/src/index.ts"), "render"],
    {
      cwd: join(root, "examples/sqlite"),
      env: {
        ...process.env,
        DANGUS_HOST: "other-host",
        DANGUS_PROXY_BIND_IPS: "192.0.2.1",
      },
      stdout: "pipe",
    },
  );
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(output).toContain("- other-host");
  expect(output).not.toContain("devbox-1");
});

test("render uses supplied resources, timeout, Host and context without a mobile App", async () => {
  const config = validateConfig({
    name: "produto",
    apps: {
      api: { domain: "api.produto.com", memoryMb: 1234 },
      mobile: { domain: "mobile.produto.com" },
    },
    database: "sqlite",
    deployTimeoutSeconds: 73,
  });
  await withRendered(
    config,
    "host.tailnet",
    async (dir, apps) => {
      expect(apps).toEqual(["api"]);
      const doc = Bun.YAML.parse(
        await Bun.file(join(dir, "api/deploy.yml")).text(),
      ) as {
        servers: { web: { hosts: string[]; options: { memory: string } } };
        deploy_timeout: number;
        builder: { context: string };
        env: { clear: { SQLITE_PATH: string } };
        volumes: string[];
      };
      expect(doc.servers.web.hosts).toEqual(["host.tailnet"]);
      expect(doc.servers.web.options.memory).toBe("1234m");
      expect(doc.deploy_timeout).toBe(73);
      expect(doc.builder.context).toBe("../..");
      expect(doc.env.clear.SQLITE_PATH).toBe("/app/data/produto.sqlite");
      expect(doc.volumes).toEqual(["produto-sqlite:/app/data"]);
    },
    "../..",
    ["192.0.2.1"],
  );
});

test("Kamal failure removes the temporary directory without exposing secrets", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com", secrets: ["TOKEN"] } },
    database: "postgres",
    deployTimeoutSeconds: 10,
  });
  let temp = "";
  const runner: Runner = async (args) => {
    if (args[0] === "git") return { code: 0, stdout: "a".repeat(40) };
    if (args[0] === "bws")
      return {
        code: 0,
        stdout: JSON.stringify([
          { key: "produto__TOKEN", value: "secret-value" },
          { key: "produto__POSTGRES_PASSWORD", value: "secret-password" },
          ...backupBws,
        ]),
      };
    temp = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    return { code: 1, stdout: "" };
  };
  const error = await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
    DANGUS_PROXY_BIND_IPS: "192.0.2.1",
  }).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("secret");
  expect(temp).not.toBe("");
  expect(await Bun.file(join(temp, ".kamal/secrets")).exists()).toBe(false);
  expect(await Bun.file(temp).exists()).toBe(false);
});

test("Kamal displays deploy output in the terminal", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  const streamed: boolean[] = [];
  const runner: Runner = async (args, _env, _cwd, stream) => {
    if (args[0] === "docker") streamed.push(stream === true);
    return {
      code: 0,
      stdout:
        args[0] === "git"
          ? "a".repeat(40)
          : args[0] === "bws"
            ? JSON.stringify(backupBws)
            : "",
    };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
    DANGUS_PROXY_BIND_IPS: "192.0.2.1",
  });
  expect(streamed).toEqual([true]);
});

test("Postgres stays on the internal network with labels and a pinned image", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com" } },
    database: "postgres",
    deployTimeoutSeconds: 10,
  });
  const doc = Bun.YAML.parse(
    render(config, "api", undefined, undefined, ["192.0.2.1"]),
  ) as {
    accessories: { db: Record<string, unknown> };
  };
  const db = doc.accessories.db;
  expect(db.port).toBeUndefined();
  expect(db.options).toBeUndefined();
  expect(db.labels).toEqual({ product: "produto", app: "postgres" });
  expect(db.image).toMatch(/^postgres:17\.6@sha256:[0-9a-f]{64}$/);
});

test("render prints readable YAML with one field per line", () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  expect(render(config, "web", undefined, undefined, ["192.0.2.1"])).toContain(
    "\nproxy:\n",
  );
});

test("rollback checks all images before deploying without a build", async () => {
  const config = validateConfig({
    name: "produto",
    apps: {
      api: { domain: "api.produto.com" },
      web: { domain: "web.produto.com" },
    },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout:
        args[0] === "git"
          ? "a".repeat(40)
          : args[0] === "bws"
            ? JSON.stringify(backupBws)
            : "",
    };
  };
  await deploy(
    config,
    "/produto",
    runner,
    { SSH_AUTH_SOCK: "/agent", DANGUS_PROXY_BIND_IPS: "192.0.2.1" },
    true,
  );
  expect(calls.slice(2, 4)).toEqual(
    ["api", "web"].map((app) => [
      "docker",
      "manifest",
      "inspect",
      `ghcr.io/dangus-box/produto-${app}:${"a".repeat(40)}`,
    ]),
  );
  expect(calls.slice(4).every((args) => args.includes("--skip-push"))).toBe(
    true,
  );
  calls.length = 0;
  const missing: Runner = async (args, env, cwd, stream) => {
    if (args[1] === "manifest" && args[3].includes("-web:")) {
      calls.push(args);
      return { code: 1, stdout: "" };
    }
    return runner(args, env, cwd, stream);
  };
  await expect(
    deploy(
      config,
      "/produto",
      missing,
      { SSH_AUTH_SOCK: "/agent", DANGUS_PROXY_BIND_IPS: "192.0.2.1" },
      true,
    ),
  ).rejects.toThrow("Image unavailable");
  expect(calls.some((args) => args[1] === "run")).toBe(false);
});

test("push deploy builds images and ignores DANGUS_SKIP_BUILD from the environment", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout:
        args[0] === "git"
          ? "a".repeat(40)
          : args[0] === "bws"
            ? JSON.stringify(backupBws)
            : "",
    };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/agent",
    DANGUS_PROXY_BIND_IPS: "192.0.2.1",
    DANGUS_SKIP_BUILD: "1",
  });
  expect(calls.some((args) => args[1] === "manifest")).toBe(false);
  expect(calls.some((args) => args.includes("--skip-push"))).toBe(false);
});

test("render uses DNS records for each App domain", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  const domains: string[] = [];
  await withRendered(
    config,
    "host",
    async (dir) => {
      const doc = Bun.YAML.parse(
        await Bun.file(join(dir, "web/deploy.yml")).text(),
      ) as {
        proxy: { run: { bind_ips: string[] } };
      };
      expect(doc.proxy.run.bind_ips).toEqual(["192.0.2.1", "2001:db8::1"]);
    },
    ".",
    undefined,
    async (domain) => {
      domains.push(domain);
      return ["192.0.2.1", "2001:db8::1"];
    },
  );
  expect(domains).toEqual(["web.produto.com"]);
});

test("DANGUS_PROXY_BIND_IPS overrides default IPs in render", async () => {
  const cli = Bun.spawn(
    ["bun", join(root, "packages/cli/src/index.ts"), "render"],
    {
      cwd: join(root, "examples/sqlite"),
      env: {
        ...process.env,
        DANGUS_PROXY_BIND_IPS: " 192.0.2.1 , 2001:db8::1 ",
      },
      stdout: "pipe",
    },
  );
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(output).toContain("- 192.0.2.1");
  expect(output).toContain("- 2001:db8::1");
});

test("invalid or empty DANGUS_PROXY_BIND_IPS stops render", async () => {
  for (const value of ["", " ", "192.0.2.1,,2001:db8::1", "invalid"]) {
    const cli = Bun.spawn(
      ["bun", join(root, "packages/cli/src/index.ts"), "render"],
      {
        cwd: join(root, "examples/sqlite"),
        env: { ...process.env, DANGUS_PROXY_BIND_IPS: value },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const error = await new Response(cli.stderr).text();
    expect(await cli.exited).toBe(1);
    expect(error).toContain("DANGUS_PROXY_BIND_IPS");
  }
});

test("deploy uses DANGUS_PROXY_BIND_IPS", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  let found = false;
  const runner: Runner = async (args) => {
    if (args[0] === "git") return { code: 0, stdout: "a".repeat(40) };
    if (args[0] === "bws")
      return { code: 0, stdout: JSON.stringify(backupBws) };
    const path = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    const doc = Bun.YAML.parse(
      await Bun.file(join(path, "deploy.yml")).text(),
    ) as {
      proxy: { run: { bind_ips: string[] } };
    };
    expect(doc.proxy.run.bind_ips).toEqual(["192.0.2.5"]);
    found = true;
    return { code: 0, stdout: "" };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
    DANGUS_PROXY_BIND_IPS: " 192.0.2.5 ",
  });
  expect(found).toBe(true);
});

test("DNS without records reports domain and override", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  await expect(
    withRendered(
      config,
      "host",
      async () => {},
      ".",
      undefined,
      async () => [],
    ),
  ).rejects.toThrow(/web\.produto\.com.*DANGUS_PROXY_BIND_IPS/);
});

test("override skips DNS lookup", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  await withRendered(
    config,
    "host",
    async (dir) => {
      const doc = Bun.YAML.parse(
        await Bun.file(join(dir, "web/deploy.yml")).text(),
      ) as {
        proxy: { run: { bind_ips: string[] } };
      };
      expect(doc.proxy.run.bind_ips).toEqual(["192.0.2.5"]);
    },
    ".",
    ["192.0.2.5"],
    async () => {
      throw new Error("DNS queried");
    },
  );
});

const dnsError = (code: string) =>
  Object.assign(new Error(`query ${code}`), { code });

test("domain with only A or AAAA uses existing records", async () => {
  const onlyA = await resolveDomain("a.produto.com", [
    async () => ["192.0.2.1"],
    async () => {
      throw dnsError("ENODATA");
    },
  ]);
  const onlyAaaa = await resolveDomain("aaaa.produto.com", [
    async () => {
      throw dnsError("ENODATA");
    },
    async () => ["2001:db8::1"],
  ]);
  expect([onlyA, onlyAaaa]).toEqual([["192.0.2.1"], ["2001:db8::1"]]);
});

test("NXDOMAIN returns an empty list and other DNS failures propagate", async () => {
  const nx = async () => {
    throw dnsError("ENOTFOUND");
  };
  expect(await resolveDomain("x.produto.com", [nx, nx])).toEqual([]);
  await expect(
    resolveDomain("x.produto.com", [
      async () => {
        throw dnsError("ETIMEOUT");
      },
      nx,
    ]),
  ).rejects.toThrow("ETIMEOUT");
});

const twoApps = () =>
  validateConfig({
    name: "produto",
    apps: {
      api: { domain: "api.produto.com" },
      web: { domain: "web.other.com" },
    },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });

test("Apps with different DNS IPs stop render", async () => {
  const ips: Record<string, string[]> = {
    "api.produto.com": ["192.0.2.1"],
    "web.other.com": ["192.0.2.2"],
  };
  await expect(
    withRendered(
      twoApps(),
      "host",
      async () => {},
      ".",
      undefined,
      async (domain) => ips[domain] ?? [],
    ),
  ).rejects.toThrow(
    /api\.produto\.com.*web\.other\.com.*DANGUS_PROXY_BIND_IPS/,
  );
});

test("DNS record order does not change bind_ips", async () => {
  const ips: Record<string, string[]> = {
    "api.produto.com": ["2001:db8::1", "192.0.2.1"],
    "web.other.com": ["192.0.2.1", "2001:db8::1"],
  };
  await withRendered(
    twoApps(),
    "host",
    async (dir, apps) => {
      for (const app of apps) {
        const doc = Bun.YAML.parse(
          await Bun.file(join(dir, app, "deploy.yml")).text(),
        ) as { proxy: { run: { bind_ips: string[] } } };
        expect(doc.proxy.run.bind_ips).toEqual(["192.0.2.1", "2001:db8::1"]);
      }
    },
    ".",
    undefined,
    async (domain) => ips[domain] ?? [],
  );
});

test("accessory protects each variant and does not include a private key", async () => {
  for (const database of ["postgres", "sqlite"] as const) {
    const config = validateConfig({
      name: "produto",
      apps: { api: { domain: "api.produto.com" } },
      database,
      deployTimeoutSeconds: 10,
    });
    const yaml = render(config, "api", "devbox-1", ".", ["192.0.2.1"]);
    const doc = Bun.YAML.parse(yaml) as {
      accessories: Record<
        string,
        {
          env: { clear: Record<string, string>; secret: string[] };
          volumes?: string[];
        }
      >;
    };
    const backup = doc.accessories.backup;
    expect(backup.env.clear.BACKUP_TYPE).toBe(database);
    expect(backup.env.clear.AGE_PUBLIC_KEY).toBeUndefined();
    expect(backup.env.secret).toContain("AGE_PUBLIC_KEY");
    expect(backup.env.secret).toContain("R2_SECRET_ACCESS_KEY");
    expect(yaml).not.toContain("AGE-SECRET-KEY-");
    if (database === "sqlite")
      expect(backup.volumes).toEqual(["produto-sqlite:/app/data"]);
    else {
      expect(backup.env.clear.PGHOST).toBe("produto-api-db");
      expect(backup.env.secret).toContain("PGPASSWORD:POSTGRES_PASSWORD");
      expect(yaml).not.toContain("DATABASE_URL:");
    }
  }
});

for (const [scenario, secrets, expectedError] of [
  [
    "missing",
    backupBws.filter((item) => item.key !== "ops__BACKUP_AGE_PUBLIC_KEY"),
    "Secret ops__BACKUP_AGE_PUBLIC_KEY is missing",
  ],
  [
    "private key",
    [
      ...backupBws.filter((item) => item.key !== "ops__BACKUP_AGE_PUBLIC_KEY"),
      { key: "ops__BACKUP_AGE_PUBLIC_KEY", value: "AGE-SECRET-KEY-1TEST" },
    ],
    "Invalid age public key",
  ],
] as const) {
  test(`deploy fails clearly with ${scenario} public key in BWS`, async () => {
    const config = validateConfig({
      name: "produto",
      apps: { api: { domain: "api.produto.com" } },
      database: "sqlite",
      deployTimeoutSeconds: 10,
    });
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args[0] === "git") return { code: 0, stdout: "a".repeat(40) };
      return { code: 0, stdout: JSON.stringify(secrets) };
    };
    await expect(
      deploy(config, "/produto", runner, {
        SSH_AUTH_SOCK: "/ssh-agent",
        DANGUS_PROXY_BIND_IPS: "192.0.2.1",
      }),
    ).rejects.toThrow(expectedError);
    expect(calls.some((args) => args[0] === "docker")).toBe(false);
  });
}

test("db backup runs the script on the existing accessory", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  let command: string[] = [];
  await backupNow(
    config,
    "/produto",
    async (args) => {
      if (args[0] === "git") return { code: 0, stdout: `${"a".repeat(40)}\n` };
      command = args;
      return { code: 0, stdout: "" };
    },
    { SSH_AUTH_SOCK: "/agent", DANGUS_PROXY_BIND_IPS: "192.0.2.1" },
  );
  // Kamal runs without a git repository in the container and requires the version.
  expect(command.slice(-8)).toEqual([
    "accessory",
    "exec",
    "backup",
    "--reuse",
    "--config-file",
    "/dangus/deploy.yml",
    `--version=${"a".repeat(40)}`,
    "/usr/local/bin/backup.sh",
  ]);
});

test("custom Postgres layout render matches its golden file", async () => {
  const config = validateConfig({
    name: "produto",
    apps: {
      api: {
        domain: "api.produto.com",
        path: "backend",
        dockerfile: "docker/api.Dockerfile",
        target: "production",
        build: {
          secrets: ["SSH_KEY"],
          args: { PUBLIC_URL: "https://example.com" },
        },
        env: { NODE_ENV: "production" },
        entry: "backend/src/main.ts",
        healthcheckPath: "/health/ready",
      },
    },
    migrations: "database/migrations",
    database: "postgres",
    deployTimeoutSeconds: 120,
  });
  expect(
    render(config, "api", "devbox-1", ".", ["192.0.2.1", "2001:db8::1"]),
  ).toBe(
    await readFile(
      join(root, "packages/cli/test/golden/postgres-layout.yml"),
      "utf8",
    ),
  );
});

for (const skipBuild of [false, true]) {
  test(`build secrets are requested only when building (skipBuild=${skipBuild})`, async () => {
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nline$with\\special\nlast-line\n-----END OPENSSH PRIVATE KEY-----\n";
    const config = validateConfig({
      name: "produto",
      apps: {
        web: {
          domain: "web.produto.com",
          build: {
            secrets: ["SSH_KEY"],
            args: { PUBLIC_URL: "https://example.com" },
          },
          env: { NODE_ENV: "production" },
        },
      },
      database: "sqlite",
      deployTimeoutSeconds: 120,
    });
    const calls: string[][] = [];
    const runner: Runner = async (args, env) => {
      calls.push(args);
      if (args[0] === "git") return { code: 0, stdout: "b".repeat(40) };
      if (args[0] === "bws")
        return {
          code: 0,
          stdout: JSON.stringify([
            { key: "produto__SSH_KEY", value: privateKey },
          ]),
        };
      if (args[1] === "manifest") return { code: 0, stdout: "" };
      expect(
        args.filter((_, i) => args[i - 1] === "-e").includes("SSH_KEY"),
      ).toBe(!skipBuild);
      expect(env.SSH_KEY).toBe(skipBuild ? undefined : privateKey);
      const path =
        args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
      const yaml = await Bun.file(join(path, "deploy.yml")).text();
      const doc = Bun.YAML.parse(yaml) as {
        builder: { args: Record<string, string>; secrets: string[] };
        env: { clear: Record<string, string>; secret: string[] };
      };
      expect(doc.builder.args).toEqual({
        PUBLIC_URL: "https://example.com",
        APP_VERSION: "b".repeat(40),
      });
      expect(doc.builder.secrets).toEqual(["SSH_KEY"]);
      expect(doc.env.clear).toEqual({
        NODE_ENV: "production",
        APP_VERSION: "b".repeat(40),
      });
      expect(doc.env.secret).not.toContain("SSH_KEY");
      const secrets = await Bun.file(join(path, ".kamal/secrets")).text();
      expect(secrets.includes("SSH_KEY=$SSH_KEY")).toBe(!skipBuild);
      expect(yaml + secrets + JSON.stringify(args)).not.toContain(privateKey);
      return { code: 0, stdout: "" };
    };
    await deploy(
      config,
      "/produto",
      runner,
      { SSH_AUTH_SOCK: "/agent", DANGUS_PROXY_BIND_IPS: "192.0.2.1" },
      skipBuild,
    );
    expect(calls.filter((args) => args[0] === "bws")).toEqual(
      skipBuild ? [] : [["bws", "secret", "list"]],
    );
  });
}

test("render prints only build secret names even when the environment contains values", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dangus-render-"));
  try {
    await Bun.write(
      join(dir, "dangus.config.ts"),
      `export default ${JSON.stringify({ name: "produto", apps: { web: { domain: "web.produto.com", build: { secrets: ["SSH_KEY"] }, secrets: ["TOKEN"] } }, database: "sqlite", deployTimeoutSeconds: 120 })}`,
    );
    const child = Bun.spawn(
      ["bun", join(root, "packages/cli/src/index.ts"), "render"],
      {
        cwd: dir,
        env: {
          ...process.env,
          DANGUS_PROXY_BIND_IPS: "192.0.2.1",
          GIT_DIR: Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], {
            cwd: root,
          })
            .stdout.toString()
            .trim(),
          SSH_KEY: "private-key-value",
          TOKEN: "private-token-value",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    expect(await child.exited).toBe(0);
    expect(output).toContain("SSH_KEY");
    expect(output).toContain("TOKEN");
    expect(output).not.toContain("private-key-value");
    expect(output).not.toContain("private-token-value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!process.env.DANGUS_TEST_KAMAL)(
  "Kamal reads a multiline build secret intact from its environment",
  async () => {
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nline$with\\special\nlast-line\n-----END OPENSSH PRIVATE KEY-----\n";
    const config = validateConfig({
      name: "produto",
      apps: {
        web: { domain: "web.produto.com", build: { secrets: ["SSH_KEY"] } },
      },
      database: "sqlite",
      deployTimeoutSeconds: 120,
    });
    await withRendered(
      config,
      "devbox-1",
      async (dir) => {
        const child = Bun.spawn(
          [
            "docker",
            "run",
            "--rm",
            "-v",
            `${join(dir, "web")}:/dangus:ro`,
            "-e",
            "SSH_KEY",
            "--entrypoint",
            "ruby",
            KAMAL_IMAGE,
            "-rkamal",
            "-e",
            'STDOUT.write(Kamal::Secrets.new(secrets_path: "/dangus/.kamal/secrets")["SSH_KEY"])',
          ],
          {
            env: { ...process.env, SSH_KEY: privateKey },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        expect(error).toBe("");
        expect(await child.exited).toBe(0);
        expect(output).toBe(privateKey);
      },
      ".",
      ["192.0.2.1"],
    );
  },
);
