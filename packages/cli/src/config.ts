import { resolve } from "node:path";

export interface ProductConfig {
  name: string;
  apps: Partial<
    Record<
      "api" | "web" | "mobile",
      { domain: string; memoryMb?: number; secrets?: string[] }
    >
  >;
  database: "postgres" | "sqlite";
  deployTimeoutSeconds: number;
  logger?: { redact?: string[] };
  backup?: { destination?: "r2" | "s3" };
}

export interface ResolvedProductConfig {
  name: string;
  apps: Partial<
    Record<
      "api" | "web" | "mobile",
      { domain: string; memoryMb: number; secrets: string[] }
    >
  >;
  database: "postgres" | "sqlite";
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

// Secrets become Docker and Kamal environment variables during deploy; these
// names control deploy or are supplied by the Platform.
const RESERVED_SECRET =
  /^(?:KAMAL_.*|DOCKER_.*|PATH|HOME|SSH_AUTH_SOCK|DATABASE_URL|POSTGRES_PASSWORD|SQLITE_PATH)$/;

export function validateConfig(value: unknown): ResolvedProductConfig {
  const config = object(value, "", [
    "name",
    "apps",
    "database",
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
    const app = object(inputApps[key], path, ["domain", "memoryMb", "secrets"]);
    // ADR-0015: zone apex or one subdomain level, including .com.br domains.
    if (
      typeof app.domain !== "string" ||
      !/^(?:(?!-)[a-z0-9-]+(?<!-)\.)?(?!-)[a-z0-9-]+(?<!-)\.(?:com\.br|[a-z]{2,})$/i.test(
        app.domain,
      )
    ) {
      fail(
        `${path}.domain`,
        "must be a zone apex or one subdomain level (e.g. product.com or api.product.com)",
      );
    }
    const secrets = app.secrets === undefined ? [] : app.secrets;
    if (
      !Array.isArray(secrets) ||
      !secrets.every(
        (secret) =>
          typeof secret === "string" &&
          /^[A-Z][A-Z0-9_]*$/.test(secret) &&
          !RESERVED_SECRET.test(secret),
      ) ||
      new Set(secrets).size !== secrets.length
    ) {
      fail(
        `${path}.secrets`,
        "must contain unique uppercase names, excluding names reserved for deploy",
      );
    }
    apps[key] = {
      domain: app.domain,
      secrets,
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
