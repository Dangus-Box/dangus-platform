import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProductConfig } from "./config";

export const KAMAL_IMAGE =
  "ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625";
type App = "api" | "web";
export type Runner = (
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  stream?: boolean,
) => Promise<{ code: number; stdout: string }>;
export const run: Runner = async (args, env, cwd, stream = false) => {
  const output = stream ? "inherit" : "pipe";
  const child = Bun.spawn(args, { cwd, env, stdout: output, stderr: output });
  const [stdout] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  return { code: await child.exited, stdout };
};

// Variáveis que o container do Kamal recebe do ambiente para a App.
function kamalSecrets(config: ResolvedProductConfig, app: App): string[] {
  const names = [
    "KAMAL_REGISTRY_PASSWORD",
    ...(config.apps[app]?.secrets ?? []),
  ];
  if (app === "api" && config.database === "postgres")
    names.push("POSTGRES_PASSWORD", "DATABASE_URL");
  return names;
}

export function render(
  config: ResolvedProductConfig,
  app: App,
  host = "dangus-host",
  buildContext = ".",
): string {
  const settings = config.apps[app];
  if (!settings) throw new Error(`App ${app} não declarada.`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
    throw new Error("Host Tailscale inválido.");
  const service = `${config.name}-${app}`;
  const secrets = [...settings.secrets];
  if (config.database === "postgres" && app === "api")
    secrets.push("DATABASE_URL");
  const doc: Record<string, unknown> = {
    service,
    secrets_path: "/dangus/.kamal/secrets",
    image: `dangus-box/${service}`,
    servers: {
      web: { hosts: [host], options: { memory: `${settings.memoryMb}m` } },
    },
    registry: {
      server: "ghcr.io",
      username: "<%= ENV.fetch('KAMAL_REGISTRY_USERNAME') %>",
      password: ["KAMAL_REGISTRY_PASSWORD"],
    },
    proxy: {
      ssl: true,
      host: settings.domain,
      app_port: 3000,
      healthcheck: { path: app === "api" ? "/ready" : "/" },
      run: { options: { label: ["product=platform", "app=proxy"] } },
    },
    builder: {
      arch: "amd64",
      dockerfile: `apps/${app}/Dockerfile`,
      context: buildContext,
    },
    deploy_timeout: config.deployTimeoutSeconds,
    labels: { product: config.name, app },
    env: { secret: secrets },
  };
  if (config.database === "sqlite" && app === "api") {
    doc.volumes = [`${config.name}-sqlite:/app/data`];
    doc.env = {
      clear: { SQLITE_PATH: "/app/data/produto.sqlite" },
      secret: secrets,
    };
  }
  if (config.database === "postgres" && app === "api")
    doc.accessories = {
      db: {
        image:
          "postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929",
        host,
        labels: { product: config.name, app: "postgres" },
        env: {
          clear: { POSTGRES_USER: "produto", POSTGRES_DB: "produto" },
          secret: ["POSTGRES_PASSWORD"],
        },
        volumes: [`${config.name}-postgres:/var/lib/postgresql/data`],
      },
    };
  return Bun.YAML.stringify(doc, null, 2);
}

export async function withRendered<T>(
  config: ResolvedProductConfig,
  host: string,
  action: (dir: string, apps: App[]) => Promise<T>,
  buildContext = ".",
): Promise<T> {
  const apps = (["api", "web"] as const).filter((app) => config.apps[app]);
  if (!apps.length) throw new Error("Nenhuma App de servidor declarada.");
  const dir = await mkdtemp(join(tmpdir(), "dangus-"));
  try {
    for (const app of apps) {
      const path = join(dir, app);
      await mkdir(join(path, ".kamal"), { recursive: true });
      await writeFile(
        join(path, "deploy.yml"),
        render(config, app, host, buildContext),
      );
      await writeFile(
        join(path, ".kamal", "secrets"),
        `${kamalSecrets(config, app)
          .map((name) => `${name}=$${name}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
    }
    return await action(dir, apps);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function deploy(
  config: ResolvedProductConfig,
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await withRendered(
    config,
    env.DANGUS_HOST || "dangus-host",
    async (dir, apps) => {
      if (!env.SSH_AUTH_SOCK) throw new Error("SSH_AUTH_SOCK é obrigatório.");
      const git = await runner(
        ["git", "rev-parse", "--verify", "HEAD"],
        env,
        directory,
      );
      const version = git.stdout.trim();
      if (git.code !== 0 || !/^[0-9a-f]{40,64}$/.test(version))
        throw new Error("Não foi possível determinar o commit do Produto.");
      const names = new Set(
        apps.flatMap((app) => config.apps[app]?.secrets ?? []),
      );
      if (config.database === "postgres" && config.apps.api)
        names.add("POSTGRES_PASSWORD");
      const values: Record<string, string> = {};
      if (names.size) {
        const result = await runner(["bws", "secret", "list"], env, directory);
        if (result.code !== 0)
          throw new Error("Falha ao consultar secrets no BWS.");
        let found: { key: string; value: string }[];
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          if (!Array.isArray(parsed)) throw new Error();
          found = parsed.filter(
            (item): item is { key: string; value: string } =>
              typeof item === "object" &&
              item !== null &&
              typeof item.key === "string" &&
              typeof item.value === "string",
          );
        } catch {
          throw new Error("Resposta inválida do BWS.");
        }
        for (const name of names) {
          const matches = found.filter(
            (item) => item.key === `${config.name}__${name}`,
          );
          if (matches.length !== 1 || typeof matches[0].value !== "string")
            throw new Error(
              `Secret ${config.name}__${name} ausente ou duplicado no BWS.`,
            );
          values[name] = matches[0].value;
        }
      }
      if (config.database === "postgres" && config.apps.api)
        values.DATABASE_URL = `postgres://produto:${encodeURIComponent(values.POSTGRES_PASSWORD)}@${config.name}-api-db:5432/produto`;
      for (const app of apps) {
        const path = join(dir, app);
        const args = [
          "docker",
          "run",
          "--rm",
          "--network",
          "host",
          "-v",
          `${resolve(directory, env.DANGUS_BUILD_CONTEXT || ".")}:${resolve(directory, env.DANGUS_BUILD_CONTEXT || ".")}`,
          "-w",
          resolve(directory),
          "-v",
          `${path}:/dangus:ro`,
          "-v",
          "/var/run/docker.sock:/var/run/docker.sock",
          "-v",
          `${env.SSH_AUTH_SOCK}:/ssh-agent`,
          "-e",
          "SSH_AUTH_SOCK=/ssh-agent",
          "-e",
          "KAMAL_REGISTRY_USERNAME",
          ...kamalSecrets(config, app).flatMap((name) => ["-e", name]),
          KAMAL_IMAGE,
          "setup",
          "--config-file",
          "/dangus/deploy.yml",
          `--version=${version}`,
        ];
        const result = await runner(
          args,
          { ...env, ...values },
          directory,
          true,
        );
        if (result.code !== 0)
          throw new Error(`Falha no deploy da App ${app}.`);
      }
    },
    env.DANGUS_BUILD_CONTEXT || ".",
  );
}
