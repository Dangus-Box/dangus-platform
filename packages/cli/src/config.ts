import { posix, resolve, win32 } from "node:path";

export interface ProductConfig {
  name: string;
  apps: Partial<
    Record<
      "api" | "web" | "mobile",
      {
        domain: string;
        memoryMb?: number;
        secrets?: string[];
        build?: { secrets?: string[]; args?: Record<string, string> };
        env?: Record<string, string>;
        path?: string;
        dockerfile?: string;
        target?: string;
        entry?: string;
        healthcheckPath?: string;
      }
    >
  >;
  database: "postgres" | "sqlite";
  migrations?: string;
  deployTimeoutSeconds: number;
  logger?: { redact?: string[] };
  backup?: { destination?: "r2" | "s3" };
}

export interface ResolvedProductConfig {
  name: string;
  apps: Partial<
    Record<
      "api" | "web" | "mobile",
      {
        domain: string;
        memoryMb: number;
        secrets: string[];
        build: { secrets: string[]; args: Record<string, string> };
        env: Record<string, string>;
        path: string;
        dockerfile: string;
        target?: string;
        entry: string;
        healthcheckPath: string;
      }
    >
  >;
  database: "postgres" | "sqlite";
  migrations: string;
  deployTimeoutSeconds: number;
  logger: { redact: string[] };
  backup: { destination: "r2" | "s3" };
}

export function defineConfig(config: ProductConfig): ProductConfig {
  return config;
}

function fail(path: string, message: string): never {
  throw new Error(`Product Config: ${path || "export default"}: ${message}`);
}

function object(
  value: unknown,
  path: string,
  keys: string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key))
      fail(path ? `${path}.${key}` : key, "unknown field");
  }
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fail(path, "must be a positive integer");
  }
  return value;
}

function relativePath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  )
    return fail(path, "must be a relative path without .. segments");
  return posix.normalize(value);
}

// The doctor passes migrations to git as a pathspec: no magic or globs.
function pathspecSafe(value: string): string {
  if (/^[-:]|[*?[\]{}!]/.test(value))
    return fail(
      "migrations",
      "must not start with - or : or contain glob characters",
    );
  return value;
}

// Secrets become Docker and Kamal environment variables during deploy; these
// names control deploy or are supplied by the Platform. Backup names would make
// deploy fetch Platform credentials from BWS for the Product.
const RESERVED_SECRET =
  /^(?:KAMAL_.*|DOCKER_.*|PATH|HOME|SSH_AUTH_SOCK|DATABASE_URL|POSTGRES_PASSWORD|SQLITE_PATH|APP_VERSION|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ENDPOINT|HEALTHCHECKS_URL|AGE_PUBLIC_KEY)$/;
// Clear variables the Platform sets in the App container.
const RESERVED_ENV =
  /^(?:DATABASE_URL|POSTGRES_PASSWORD|SQLITE_PATH|APP_VERSION)$/;

function secretNames(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (name) =>
        typeof name === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(name) &&
        !RESERVED_SECRET.test(name),
    ) ||
    new Set(value).size !== value.length
  )
    fail(
      path,
      "must contain unique uppercase names, excluding names reserved for deploy",
    );
  return value;
}

function variables(
  value: unknown,
  path: string,
  singleLine: boolean,
  reserved: RegExp,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || reserved.test(name))
      fail(`${path}.${name}`, "invalid or reserved variable name");
    // Kamal renders deploy.yml through ERB, which could interpolate secrets.
    if (typeof entry === "string" && entry.includes("<%"))
      fail(`${path}.${name}`, "must not contain ERB tags (<%)");
    if (
      typeof entry !== "string" ||
      entry.includes("\0") ||
      (singleLine && /[\r\n]/.test(entry))
    )
      fail(
        `${path}.${name}`,
        singleLine
          ? "must be a single-line string"
          : "must be a string without null bytes",
      );
  }
  return value as Record<string, string>;
}

export function validateConfig(value: unknown): ResolvedProductConfig {
  const config = object(value, "", [
    "name",
    "apps",
    "database",
    "migrations",
    "deployTimeoutSeconds",
    "logger",
    "backup",
  ]);
  // The name becomes the service, container and database name in generated config (ADR-0004).
  if (
    typeof config.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.name)
  )
    fail("name", "must contain only lowercase letters, numbers and hyphens");
  const inputApps = object(config.apps, "apps", ["api", "web", "mobile"]);
  if (Object.keys(inputApps).length === 0)
    fail("apps", "must declare at least one App");
  const apps: ResolvedProductConfig["apps"] = {};
  for (const key of ["api", "web", "mobile"] as const) {
    if (inputApps[key] === undefined) continue;
    const path = `apps.${key}`;
    const app = object(inputApps[key], path, [
      "domain",
      "memoryMb",
      "secrets",
      "build",
      "env",
      "path",
      "dockerfile",
      "target",
      "entry",
      "healthcheckPath",
    ]);
    const appPath = relativePath(
      app.path === undefined ? `apps/${key}` : app.path,
      `${path}.path`,
    );
    const dockerfile = relativePath(
      app.dockerfile === undefined ? `${appPath}/Dockerfile` : app.dockerfile,
      `${path}.dockerfile`,
    );
    const entry = relativePath(
      app.entry === undefined ? `${appPath}/index.ts` : app.entry,
      `${path}.entry`,
    );
    if (
      app.target !== undefined &&
      (typeof app.target !== "string" || !/^[A-Za-z0-9_.-]+$/.test(app.target))
    )
      fail(`${path}.target`, "must contain only letters, numbers, _, . and -");
    const healthcheckPath =
      app.healthcheckPath === undefined
        ? key === "api"
          ? "/ready"
          : "/"
        : app.healthcheckPath;
    if (
      typeof healthcheckPath !== "string" ||
      !/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(healthcheckPath)
    )
      fail(
        `${path}.healthcheckPath`,
        "must be a URL path starting with a single / and without spaces or #",
      );
    // ADR-0009: one subdomain level, including .com.br domains.
    if (
      typeof app.domain !== "string" ||
      !/^(?!-)[a-z0-9-]+(?<!-)\.(?!-)[a-z0-9-]+(?<!-)\.(?:com\.br|[a-z]{2,})$/i.test(
        app.domain,
      )
    ) {
      fail(
        `${path}.domain`,
        "must be a domain with one subdomain level (e.g. api.product.com)",
      );
    }
    const secrets = secretNames(
      app.secrets === undefined ? [] : app.secrets,
      `${path}.secrets`,
    );
    const build =
      app.build === undefined
        ? {}
        : object(app.build, `${path}.build`, ["secrets", "args"]);
    const buildSecrets = secretNames(
      build.secrets === undefined ? [] : build.secrets,
      `${path}.build.secrets`,
    );
    const args = variables(
      build.args === undefined ? {} : build.args,
      `${path}.build.args`,
      false,
      /^APP_VERSION$/,
    );
    const env = variables(
      app.env === undefined ? {} : app.env,
      `${path}.env`,
      true,
      RESERVED_ENV,
    );
    for (const name of [...secrets, ...buildSecrets]) {
      if (Object.hasOwn(env, name))
        fail(`${path}.env.${name}`, "also declared as a secret");
      if (Object.hasOwn(args, name))
        fail(`${path}.build.args.${name}`, "also declared as a secret");
    }
    apps[key] = {
      domain: app.domain,
      path: appPath,
      dockerfile,
      ...(app.target === undefined ? {} : { target: app.target }),
      entry,
      healthcheckPath,
      secrets,
      build: { secrets: buildSecrets, args },
      env,
      memoryMb: positiveInteger(
        app.memoryMb === undefined ? 512 : app.memoryMb,
        `${path}.memoryMb`,
      ),
    };
  }
  if (config.database !== "postgres" && config.database !== "sqlite")
    fail("database", "must be postgres or sqlite");
  const deployTimeoutSeconds = positiveInteger(
    config.deployTimeoutSeconds,
    "deployTimeoutSeconds",
  );
  const logger =
    config.logger === undefined
      ? {}
      : object(config.logger, "logger", ["redact"]);
  const redact = logger.redact === undefined ? [] : logger.redact;
  if (
    !Array.isArray(redact) ||
    !redact.every((item) => typeof item === "string" && item.length > 0)
  ) {
    fail("logger.redact", "must be a list of nonempty fields");
  }
  const backup =
    config.backup === undefined
      ? {}
      : object(config.backup, "backup", ["destination"]);
  const destination =
    backup.destination === undefined ? "r2" : backup.destination;
  if (destination !== "r2" && destination !== "s3")
    fail("backup.destination", "must be r2 or s3");
  return {
    name: config.name,
    apps,
    database: config.database,
    migrations: pathspecSafe(
      relativePath(
        config.migrations === undefined ? "drizzle" : config.migrations,
        "migrations",
      ),
    ),
    deployTimeoutSeconds,
    logger: { redact },
    backup: { destination },
  };
}

export async function loadConfig(
  directory = process.cwd(),
): Promise<ResolvedProductConfig> {
  const path = resolve(directory, "dangus.config.ts");
  const module = await import(path);
  return validateConfig(module.default);
}
