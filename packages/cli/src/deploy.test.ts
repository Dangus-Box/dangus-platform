import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig } from "./config";
import {
  deploy,
  KAMAL_IMAGE,
  type Runner,
  render,
  withRendered,
} from "./deploy";

const root = resolve(import.meta.dir, "../../..");
for (const variant of ["postgres", "sqlite"]) {
  test(`render da variante ${variant} corresponde aos arquivos de referência`, async () => {
    const product = join(root, "examples", variant);
    const config = await loadConfig(product);
    await withRendered(config, "dangus-host", async (dir, apps) => {
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
    });
    const cli = Bun.spawn(
      ["bun", join(root, "packages/cli/src/index.ts"), "render"],
      { cwd: product, stdout: "pipe", stderr: "pipe" },
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
        ? ["-e", "TOKEN", "-e", "POSTGRES_PASSWORD", "-e", "DATABASE_URL"]
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
    deploy(config, "/produto", runner, { SSH_AUTH_SOCK: "/ssh-agent" }),
  ).rejects.toThrow("produto__TOKEN");
  expect(calls).toEqual([
    ["git", "rev-parse", "--verify", "HEAD"],
    ["bws", "secret", "list"],
  ]);
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
        ]),
      };
    temp = args[args.indexOf("-v", args.indexOf("-w")) + 1].split(":")[0];
    return { code: 1, stdout: "" };
  };
  const error = await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/ssh-agent",
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
    return { code: 0, stdout: args[0] === "git" ? "a".repeat(40) : "" };
  };
  await deploy(config, "/produto", runner, { SSH_AUTH_SOCK: "/ssh-agent" });
  expect(streamed).toEqual([true]);
});

test("Postgres fica só na rede interna, com labels e imagem fixada", async () => {
  const config = validateConfig({
    name: "produto",
    apps: { api: { domain: "api.produto.com" } },
    database: "postgres",
    deployTimeoutSeconds: 10,
  });
  const doc = Bun.YAML.parse(render(config, "api")) as {
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
  expect(render(config, "web")).toContain("\nproxy:\n");
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
    return { code: 0, stdout: args[0] === "git" ? "a".repeat(40) : "" };
  };
  await deploy(config, "/produto", runner, {
    SSH_AUTH_SOCK: "/agent",
    DANGUS_SKIP_BUILD: "1",
  });
  expect(calls.slice(1, 3)).toEqual(
    ["api", "web"].map((app) => [
      "docker",
      "manifest",
      "inspect",
      `ghcr.io/dangus-box/produto-${app}:${"a".repeat(40)}`,
    ]),
  );
  expect(calls.slice(3).every((args) => args.includes("--skip-push"))).toBe(
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
    deploy(config, "/produto", missing, {
      SSH_AUTH_SOCK: "/agent",
      DANGUS_SKIP_BUILD: "1",
    }),
  ).rejects.toThrow("Imagem indisponível");
  expect(calls.some((args) => args[1] === "run")).toBe(false);
});
