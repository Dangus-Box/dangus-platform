import { resolve4, resolve6 } from "node:dns/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProductConfig } from "./config";

export const KAMAL_IMAGE =
  "ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625";
// Nome do Host na tailnet; DANGUS_HOST substitui.
export const DEFAULT_HOST = "devbox-1";
export type Resolver = (domain: string) => Promise<string[]>;
export async function resolveDomain(
  domain: string,
  lookups: Resolver[] = [resolve4, resolve6],
): Promise<string[]> {
  const records = await Promise.all(
    lookups.map(async (resolveRecords) => {
      try {
        return await resolveRecords(domain);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENODATA" || error.code === "ENOTFOUND")
        )
          return [];
        throw error;
      }
    }),
  );
  return records.flat();
}
type App = "api" | "web";
export type Runner = (
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  stream?: boolean,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr?: string }>;
export const run: Runner = async (args, env, cwd, stream = false, signal) => {
  const output = stream ? "inherit" : "pipe";
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: output,
    stderr: output,
    signal,
    killSignal: "SIGINT",
  });
  const [stdout, stderr] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  return { code: await child.exited, stdout, stderr };
};

export function proxyBindIps(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value.split(",").map((ip) => ip.trim());
}

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
  host = DEFAULT_HOST,
  buildContext = ".",
  bindIps: string[] = [],
): string {
  const settings = config.apps[app];
  if (!settings) throw new Error(`App ${app} não declarada.`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
    throw new Error("Host Tailscale inválido.");
  if (!bindIps.length || bindIps.some((ip) => !isIP(ip)))
    throw new Error(
      "DANGUS_PROXY_BIND_IPS deve conter IPs válidos, separados por vírgulas.",
    );
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
      run: {
        bind_ips: bindIps,
        options: { label: ["product=platform", "app=proxy"] },
      },
    },
    builder: {
      arch: "amd64",
      dockerfile: `apps/${app}/Dockerfile`,
      context: buildContext,
    },
    deploy_timeout: config.deployTimeoutSeconds,
    labels: {
      product: config.name,
      app,
      ...(app === "api"
        ? { "prometheus.io.scrape": "true", "prometheus.io.port": "3000" }
        : {}),
    },
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

// O kamal-proxy é um container por Host e o Kamal ignora o bind_ips de um
// deploy quando o container já existe, então todas as Apps precisam do mesmo.
async function resolveBindIps(
  config: ResolvedProductConfig,
  apps: App[],
  resolver: Resolver,
): Promise<string[]> {
  const domains = apps.flatMap((app) => config.apps[app]?.domain ?? []);
  const resolved = await Promise.all(
    domains.map(async (domain) => (await resolver(domain)).sort()),
  );
  const empty = resolved.findIndex((ips) => !ips.length);
  if (empty >= 0)
    throw new Error(
      `Nenhum IP encontrado no DNS de ${domains[empty]}; defina DANGUS_PROXY_BIND_IPS.`,
    );
  if (new Set(resolved.map((ips) => ips.join(","))).size > 1)
    throw new Error(
      `${domains.join(" e ")} apontam para IPs diferentes no DNS; o proxy do Host é único, aponte-os para o mesmo Host ou defina DANGUS_PROXY_BIND_IPS.`,
    );
  return resolved[0] ?? [];
}

export async function withRendered<T>(
  config: ResolvedProductConfig,
  host: string,
  action: (dir: string, apps: App[]) => Promise<T>,
  buildContext = ".",
  bindIps?: string[],
  resolver: Resolver = resolveDomain,
): Promise<T> {
  const apps = (["api", "web"] as const).filter((app) => config.apps[app]);
  if (!apps.length) throw new Error("Nenhuma App de servidor declarada.");
  const addresses = bindIps ?? (await resolveBindIps(config, apps, resolver));
  const dir = await mkdtemp(join(tmpdir(), "dangus-"));
  try {
    for (const app of apps) {
      const path = join(dir, app);
      await mkdir(join(path, ".kamal"), { recursive: true });
      await writeFile(
        join(path, "deploy.yml"),
        render(config, app, host, buildContext, addresses),
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
  skipBuild = false,
  resolver: Resolver = resolveDomain,
): Promise<void> {
  await withRendered(
    config,
    env.DANGUS_HOST || DEFAULT_HOST,
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
      if (skipBuild) {
        for (const app of apps) {
          const image = `ghcr.io/dangus-box/${config.name}-${app}:${version}`;
          const result = await runner(
            ["docker", "manifest", "inspect", image],
            env,
            directory,
          );
          if (result.code !== 0)
            throw new Error(`Imagem indisponível: ${image}.`);
        }
      }
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
          ...(env.DANGUS_SSH_KNOWN_HOSTS
            ? ["-v", `${env.DANGUS_SSH_KNOWN_HOSTS}:/root/.ssh/known_hosts:ro`]
            : []),
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
          ...(skipBuild ? ["--skip-push"] : []),
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
    proxyBindIps(env.DANGUS_PROXY_BIND_IPS),
    resolver,
  );
}
