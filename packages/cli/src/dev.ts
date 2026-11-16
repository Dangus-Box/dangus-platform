import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProductConfig } from "./config";
import { type Runner, run } from "./deploy";

export async function dev(
  config: ResolvedProductConfig,
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<void> {
  const localEnv = { ...env, NODE_ENV: "development", DANGUS_DEV: "1" };
  if (config.database === "sqlite") {
    if (
      (await runner(["bun", "run", "dev"], localEnv, directory, true, signal))
        .code !== 0
    )
      throw new Error("Falha ao executar a App em desenvolvimento.");
    return;
  }
  const port = env.DANGUS_DEV_POSTGRES_PORT || "55432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("DANGUS_DEV_POSTGRES_PORT inválida.");
  const dir = await mkdtemp(join(tmpdir(), "dangus-dev-"));
  const file = join(dir, "compose.yml");
  const compose = [
    "docker",
    "compose",
    "-p",
    // Um projeto por diretório: outra worktree do Produto não derruba este banco.
    `dangus-dev-${config.name}-${Bun.hash(resolve(directory)).toString(36)}`,
    "-f",
    file,
  ];
  try {
    await writeFile(
      file,
      Bun.YAML.stringify({
        services: {
          postgres: {
            image:
              "postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929",
            environment: {
              POSTGRES_USER: "produto",
              POSTGRES_PASSWORD: "produto",
              POSTGRES_DB: "produto",
            },
            ports: [`127.0.0.1:${port}:5432`],
            volumes: ["data:/var/lib/postgresql/data"],
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -U produto -d produto"],
              interval: "1s",
              timeout: "5s",
              retries: 30,
            },
          },
        },
        volumes: { data: {} },
      }),
    );
    if (
      (
        await runner(
          [...compose, "up", "-d", "--wait"],
          localEnv,
          directory,
          true,
          signal,
        )
      ).code !== 0
    )
      throw new Error("Falha ao iniciar o Postgres local.");
    const appEnv = {
      ...localEnv,
      DATABASE_URL:
        env.DATABASE_URL ||
        `postgres://produto:produto@localhost:${port}/produto`,
    };
    if (
      (await runner(["bun", "run", "dev"], appEnv, directory, true, signal))
        .code !== 0
    )
      throw new Error("Falha ao executar a App em desenvolvimento.");
  } finally {
    try {
      if (
        (await runner([...compose, "down"], localEnv, directory, true)).code !==
        0
      )
        console.error("Falha ao parar o Postgres local.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
