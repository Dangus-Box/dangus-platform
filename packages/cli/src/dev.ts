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
      throw new Error("Failed to run the App in development.");
    return;
  }
  const port = env.DANGUS_DEV_POSTGRES_PORT || "55432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Invalid DANGUS_DEV_POSTGRES_PORT.");
  const dir = await mkdtemp(join(tmpdir(), "dangus-dev-"));
  const file = join(dir, "compose.yml");
  const compose = [
    "docker",
    "compose",
    "-p",
    // One project per directory: another Product worktree cannot stop this database.
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
              "postgres:18.1@sha256:1090bc3a8ccfb0b55f78a494d76f8d603434f7e4553543d6e807bc7bd6bbd17f",
            environment: {
              POSTGRES_USER: "produto",
              POSTGRES_PASSWORD: "produto",
              POSTGRES_DB: "produto",
            },
            ports: [`127.0.0.1:${port}:5432`],
            volumes: ["data:/var/lib/postgresql"],
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
      throw new Error("Failed to start local Postgres.");
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
      throw new Error("Failed to run the App in development.");
  } finally {
    try {
      if (
        (await runner([...compose, "down"], localEnv, directory, true)).code !==
        0
      )
        console.error("Failed to stop local Postgres.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
