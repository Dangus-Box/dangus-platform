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
  throw new Error(`Config do Produto: ${path || "export default"}: ${message}`);
}

function object(
  value: unknown,
  path: string,
  keys: string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "deve ser um objeto");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key))
      fail(path ? `${path}.${key}` : key, "campo desconhecido");
  }
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fail(path, "deve ser um número inteiro positivo");
  }
  return value;
}

export function validateConfig(value: unknown): ResolvedProductConfig {
  const config = object(value, "", [
    "name",
    "apps",
    "database",
    "deployTimeoutSeconds",
    "logger",
    "backup",
  ]);
  // O nome vira nome de serviço, container e banco na config gerada (ADR-0004).
  if (
    typeof config.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.name)
  )
    fail("name", "deve usar apenas letras minúsculas, números e hífens");
  const inputApps = object(config.apps, "apps", ["api", "web", "mobile"]);
  if (Object.keys(inputApps).length === 0)
    fail("apps", "deve declarar ao menos uma App");
  const apps: ResolvedProductConfig["apps"] = {};
  for (const key of ["api", "web", "mobile"] as const) {
    if (inputApps[key] === undefined) continue;
    const path = `apps.${key}`;
    const app = object(inputApps[key], path, ["domain", "memoryMb", "secrets"]);
    // ADR-0009: um nível de subdomínio, inclusive em domínios .com.br.
    if (
      typeof app.domain !== "string" ||
      !/^(?!-)[a-z0-9-]+(?<!-)\.(?!-)[a-z0-9-]+(?<!-)\.(?:com\.br|[a-z]{2,})$/i.test(
        app.domain,
      )
    ) {
      fail(
        `${path}.domain`,
        "deve ser um domínio com um nível de subdomínio (ex.: api.produto.com)",
      );
    }
    const secrets = app.secrets === undefined ? [] : app.secrets;
    if (
      !Array.isArray(secrets) ||
      !secrets.every(
        (secret) =>
          typeof secret === "string" && /^[A-Z][A-Z0-9_]*$/.test(secret),
      ) ||
      new Set(secrets).size !== secrets.length
    ) {
      fail(`${path}.secrets`, "deve conter nomes únicos em maiúsculas");
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
    fail("database", "deve ser postgres ou sqlite");
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
    fail("logger.redact", "deve ser uma lista de campos não vazios");
  }
  const backup =
    config.backup === undefined
      ? {}
      : object(config.backup, "backup", ["destination"]);
  const destination =
    backup.destination === undefined ? "r2" : backup.destination;
  if (destination !== "r2" && destination !== "s3")
    fail("backup.destination", "deve ser r2 ou s3");
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
