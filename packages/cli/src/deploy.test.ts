import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig } from "./config";
import {
  deploy,
  KAMAL_IMAGE,
  type Runner,
  render,
  resolveDomain,
  withRendered,
} from "./deploy";

const root = resolve(import.meta.dir, "../../..");
process.env.DANGUS_BACKUP_AGE_PUBLIC_KEY_FILE = join(
  root,
  "packages/cli/test/fixtures/age.pub",
);
const backupBws = [
  { key: "ops__R2_BACKUP_ACCESS_KEY_ID", value: "access" },
  { key: "ops__R2_BACKUP_SECRET_ACCESS_KEY", value: "secret" },
  { key: "platform__R2_ENDPOINT", value: "https://example.com" },
  {
    key: "produto__HEALTHCHECKS_BACKUP_URL",
    value: "https://example.com/check",
  },
];
for (const variant of ["postgres", "sqlite"]) {
  test(`render da variante ${variant} corresponde aos arquivos de referência`, async () => {
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
      await readFile(
        join(root, "packages/cli/test/golden", `${variant}-api.yml`),
        "utf8",
      ),
    );
    expect(output).toContain(
      await readFile(
        join(root, "packages/cli/test/golden", `${variant}-web.yml`),
        "utf8",
      ),
    );
  });
}

test("deploy transmite secrets apenas pelo ambiente e usa comandos exatos", async () => {
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
          { key: "produto__TOKEN", value: "valor-secreto" },
          { key: "produto__POSTGRES_PASSWORD", value: "senha-secreta" },
          ...backupBws,
        ]),
      };
    expect(env.TOKEN).toBe("valor-secreto");
    expect(env.DATABASE_URL).toBe(
      "postgres://produto:senha-secreta@produto-api-db:5432/produto",
    );
    temp = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    const configPath = join(temp, "deploy.yml");
    const files =
      (await readFile(configPath, "utf8")) +
      (await readFile(join(temp, ".kamal/secrets"), "utf8"));
    expect(files).not.toContain("valor-secreto");
    expect(files).not.toContain("senha-secreta");
    return { code: 0, stdout: "" };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
    DANGUS_PROXY_BIND_IPS: "192.0.2.1",
    KAMAL_REGISTRY_USERNAME: "usuario",
    KAMAL_REGISTRY_PASSWORD: "registro-secreto",
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
  expect(JSON.stringify(calls)).not.toContain("secreta");
  expect(JSON.stringify(calls)).not.toContain("secreto");
  expect(await Bun.file(join(temp, "deploy.yml")).exists()).toBe(false);
});

test("secret ausente interrompe deploy antes de chamar Docker", async () => {
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

test("DANGUS_HOST substitui o Host padrão devbox-1", async () => {
  const cli = Bun.spawn(
    ["bun", join(root, "packages/cli/src/index.ts"), "render"],
    {
      cwd: join(root, "examples/sqlite"),
      env: {
        ...process.env,
        DANGUS_HOST: "outro-host",
        DANGUS_PROXY_BIND_IPS: "192.0.2.1",
      },
      stdout: "pipe",
    },
  );
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);
  expect(output).toContain("- outro-host");
  expect(output).not.toContain("devbox-1");
});

test("render usa recursos, timeout, Host e contexto informados, sem App mobile", async () => {
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

test("falha do Kamal remove a pasta temporária sem expor secrets", async () => {
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
          { key: "produto__TOKEN", value: "valor-secreto" },
          { key: "produto__POSTGRES_PASSWORD", value: "senha-secreta" },
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

test("Kamal mostra a saída do deploy no terminal", async () => {
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

test("Postgres fica só na rede interna, com labels e imagem fixada", async () => {
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

test("render imprime YAML legível, um campo por linha", () => {
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

test("rollback verifica todas as imagens antes de deployar sem build", async () => {
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
  ).rejects.toThrow("Imagem indisponível");
  expect(calls.some((args) => args[1] === "run")).toBe(false);
});

test("deploy de push constrói as imagens e ignora DANGUS_SKIP_BUILD do ambiente", async () => {
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

test("render usa os registros DNS do domínio de cada App", async () => {
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

test("DANGUS_PROXY_BIND_IPS substitui os IPs padrão no render", async () => {
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

test("DANGUS_PROXY_BIND_IPS inválido ou vazio interrompe o render", async () => {
  for (const value of ["", " ", "192.0.2.1,,2001:db8::1", "inválido"]) {
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

test("deploy usa DANGUS_PROXY_BIND_IPS", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { web: { domain: "web.produto.com" } },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });
  let found = false;
  const runner: Runner = async (args) => {
    if (args[0] === "git") return { code: 0, stdout: "a".repeat(40) };
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

test("DNS sem registros informa domínio e override", async () => {
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

test("override dispensa consulta DNS", async () => {
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
      throw new Error("DNS consultado");
    },
  );
});

const dnsError = (code: string) =>
  Object.assign(new Error(`query ${code}`), { code });

test("domínio só com A ou só com AAAA usa os registros existentes", async () => {
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

test("NXDOMAIN resulta em lista vazia e outras falhas de DNS propagam", async () => {
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
      web: { domain: "web.outro.com" },
    },
    database: "sqlite",
    deployTimeoutSeconds: 10,
  });

test("Apps com IPs diferentes no DNS interrompem o render", async () => {
  const ips: Record<string, string[]> = {
    "api.produto.com": ["192.0.2.1"],
    "web.outro.com": ["192.0.2.2"],
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
    /api\.produto\.com.*web\.outro\.com.*DANGUS_PROXY_BIND_IPS/,
  );
});

test("ordem dos registros DNS não altera o bind_ips", async () => {
  const ips: Record<string, string[]> = {
    "api.produto.com": ["2001:db8::1", "192.0.2.1"],
    "web.outro.com": ["192.0.2.1", "2001:db8::1"],
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

test("accessory protege cada variante e não inclui chave privada", async () => {
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
    expect(backup.env.clear.AGE_PUBLIC_KEY).toStartWith("age1");
    expect(backup.env.secret).toContain("R2_SECRET_ACCESS_KEY");
    expect(yaml).not.toContain("AGE-SECRET-KEY-");
    if (database === "sqlite")
      expect(backup.volumes).toContain("produto-sqlite:/app/data:ro");
    else expect(backup.env.secret).toContain("DATABASE_URL");
  }
});

test("render falha claramente sem a chave pública", () => {
  const previous = process.env.DANGUS_BACKUP_AGE_PUBLIC_KEY_FILE;
  process.env.DANGUS_BACKUP_AGE_PUBLIC_KEY_FILE = "/nao-existe/age.pub";
  try {
    const config = validateConfig({
      name: "produto",
      apps: { api: { domain: "api.produto.com" } },
      database: "sqlite",
      deployTimeoutSeconds: 10,
    });
    expect(() => render(config, "api", "devbox-1", ".", ["192.0.2.1"])).toThrow(
      "Chave pública age ausente",
    );
  } finally {
    process.env.DANGUS_BACKUP_AGE_PUBLIC_KEY_FILE = previous;
  }
});
