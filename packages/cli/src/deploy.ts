import { resolve4, resolve6 } from "node:dns/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProductConfig } from "./config";

const BACKUP_IMAGE = "ghcr.io/dangus-box/backup:1.0.0";
// Backup accessory secrets and their BWS keys.
const backupSecretKeys = (product: string): Record<string, string> => ({
  R2_ACCESS_KEY_ID: "ops__R2_BACKUP_ACCESS_KEY_ID",
  R2_SECRET_ACCESS_KEY: "ops__R2_BACKUP_SECRET_ACCESS_KEY",
  R2_ENDPOINT: "platform__R2_ENDPOINT",
  HEALTHCHECKS_URL: `${product}__HEALTHCHECKS_BACKUP_URL`,
  AGE_PUBLIC_KEY: "ops__BACKUP_AGE_PUBLIC_KEY",
});
const backupSecrets = Object.keys(backupSecretKeys(""));
export const KAMAL_IMAGE =
  "ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625";
// Host name on the tailnet; DANGUS_HOST overrides it.
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

// Variables the Kamal container receives from the environment for the App.
function kamalSecrets(config: ResolvedProductConfig, app: App): string[] {
  const names = [
    "KAMAL_REGISTRY_PASSWORD",
    ...(config.apps[app]?.secrets ?? []),
  ];
  if (app === "api" && config.database === "postgres")
    names.push("POSTGRES_PASSWORD", "DATABASE_URL");
  if (app === "api") names.push(...backupSecrets);
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
  if (!settings) throw new Error(`App ${app} is not declared.`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
    throw new Error("Invalid Tailscale Host.");
  if (!bindIps.length || bindIps.some((ip) => !isIP(ip)))
    throw new Error(
      "DANGUS_PROXY_BIND_IPS must contain valid IPs separated by commas.",
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
  if (app === "api") {
    const accessories = (doc.accessories ?? {}) as Record<string, unknown>;
    accessories.backup = {
      image: BACKUP_IMAGE,
      host,
      labels: { product: config.name, app: "backup" },
      env: {
        clear: {
          BACKUP_PRODUCT: config.name,
          BACKUP_DATABASE: "produto",
          BACKUP_TYPE: config.database,
          ...(config.database === "sqlite"
            ? { SQLITE_PATH: "/app/data/produto.sqlite" }
            : {
                PGHOST: `${config.name}-api-db`,
                PGUSER: "produto",
                PGDATABASE: "produto",
              }),
        },
        // pg_dump reads the password from the environment; a URL in argv would be visible in /proc.
        secret: [
          ...backupSecrets,
          ...(config.database === "postgres"
            ? ["PGPASSWORD:POSTGRES_PASSWORD"]
            : []),
        ],
      },
      // Without :ro: SQLite in WAL mode needs to write -shm to open the database.
      ...(config.database === "sqlite"
        ? { volumes: [`${config.name}-sqlite:/app/data`] }
        : {}),
    };
    doc.accessories = accessories;
  }
  return Bun.YAML.stringify(doc, null, 2);
}

// There is one kamal-proxy container per Host and Kamal ignores bind_ips in a
// deploy when the container already exists, so all Apps need the same value.
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
      `No IP found in DNS for ${domains[empty]}; set DANGUS_PROXY_BIND_IPS.`,
    );
  if (new Set(resolved.map((ips) => ips.join(","))).size > 1)
    throw new Error(
      `${domains.join(" and ")} resolve to different DNS IPs; the Host has one proxy, so point them to the same Host or set DANGUS_PROXY_BIND_IPS.`,
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
  if (!apps.length) throw new Error("No server App declared.");
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
      if (!env.SSH_AUTH_SOCK) throw new Error("SSH_AUTH_SOCK is required.");
      const version = await productVersion(runner, env, directory);
      const names = new Set(
        apps.flatMap((app) => config.apps[app]?.secrets ?? []),
      );
      if (config.database === "postgres" && config.apps.api)
        names.add("POSTGRES_PASSWORD");
      if (config.apps.api) for (const name of backupSecrets) names.add(name);
      const values: Record<string, string> = {};
      if (names.size) {
        const result = await runner(["bws", "secret", "list"], env, directory);
        if (result.code !== 0)
          throw new Error("Failed to query secrets in BWS.");
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
          throw new Error("Invalid BWS response.");
        }
        const keys = backupSecretKeys(config.name);
        for (const name of names) {
          const key = keys[name] ?? `${config.name}__${name}`;
          const matches = found.filter((item) => item.key === key);
          if (matches.length !== 1 || typeof matches[0].value !== "string")
            throw new Error(`Secret ${key} is missing or duplicated in BWS.`);
          values[name] = matches[0].value;
        }
      }
      if (
        values.AGE_PUBLIC_KEY !== undefined &&
        !/^age1[0-9a-z]+$/.test(values.AGE_PUBLIC_KEY)
      )
        throw new Error("Invalid age public key in BWS.");
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
            throw new Error(`Image unavailable: ${image}.`);
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
        if (result.code !== 0) throw new Error(`Failed to deploy App ${app}.`);
      }
    },
    env.DANGUS_BUILD_CONTEXT || ".",
    proxyBindIps(env.DANGUS_PROXY_BIND_IPS),
    resolver,
  );
}

async function productVersion(
  runner: Runner,
  env: Record<string, string | undefined>,
  directory: string,
): Promise<string> {
  const git = await runner(
    ["git", "rev-parse", "--verify", "HEAD"],
    env,
    directory,
  );
  const version = git.stdout.trim();
  if (git.code !== 0 || !/^[0-9a-f]{40,64}$/.test(version))
    throw new Error("Could not determine the Product commit.");
  return version;
}

export async function backupNow(
  config: ResolvedProductConfig,
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!config.apps.api) throw new Error("Backup requires an API App.");
  if (!env.SSH_AUTH_SOCK) throw new Error("SSH_AUTH_SOCK is required.");
  await withRendered(
    config,
    env.DANGUS_HOST || DEFAULT_HOST,
    async (dir) => {
      const version = await productVersion(runner, env, directory);
      const result = await runner(
        [
          "docker",
          "run",
          "--rm",
          "--network",
          "host",
          "-v",
          `${join(dir, "api")}:/dangus:ro`,
          ...(env.DANGUS_SSH_KNOWN_HOSTS
            ? ["-v", `${env.DANGUS_SSH_KNOWN_HOSTS}:/root/.ssh/known_hosts:ro`]
            : []),
          "-v",
          `${env.SSH_AUTH_SOCK}:/ssh-agent`,
          "-e",
          "SSH_AUTH_SOCK=/ssh-agent",
          "-e",
          "KAMAL_REGISTRY_USERNAME",
          KAMAL_IMAGE,
          "accessory",
          "exec",
          "backup",
          "--reuse",
          "--config-file",
          "/dangus/deploy.yml",
          `--version=${version}`,
          "/usr/local/bin/backup.sh",
        ],
        env,
        directory,
        true,
      );
      if (result.code !== 0) throw new Error("Backup failed.");
    },
    env.DANGUS_BUILD_CONTEXT || ".",
    proxyBindIps(env.DANGUS_PROXY_BIND_IPS),
  );
}
