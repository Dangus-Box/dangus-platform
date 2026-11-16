#!/usr/bin/env bun
import { join } from "node:path";
import { version } from "../package.json";
import { bootstrap } from "./bootstrap";
import { loadConfig } from "./config";
import { DEFAULT_HOST, deploy, proxyBindIps, withRendered } from "./deploy";
import { dev } from "./dev";
import { doctor } from "./doctor";
import { listProducts } from "./ls";

if (process.argv[2] === "--version" && process.argv.length === 3) {
  console.log(version);
} else if (process.argv[2] === "doctor") {
  const args = process.argv.slice(3);
  if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1])) {
    console.error("Uso: dangus doctor [--base <ref>]");
    process.exitCode = 1;
  } else {
    const results = await doctor(process.cwd(), args[1]);
    for (const item of results) console.log(`[${item.status}] ${item.message}`);
    if (results.some((item) => item.status === "fail")) process.exitCode = 1;
  }
} else if (
  (process.argv[2] === "render" || process.argv[2] === "deploy") &&
  process.argv.length === 3
) {
  try {
    const config = await loadConfig();
    if (process.argv[2] === "deploy") await deploy(config, process.cwd());
    else
      await withRendered(
        config,
        process.env.DANGUS_HOST || DEFAULT_HOST,
        async (dir, apps) => {
          for (const app of apps)
            console.log(await Bun.file(join(dir, app, "deploy.yml")).text());
        },
        process.env.DANGUS_BUILD_CONTEXT || ".",
        proxyBindIps(process.env.DANGUS_PROXY_BIND_IPS),
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Falha no deploy.");
    process.exitCode = 1;
  }
} else if (
  (process.argv[2] === "dev" || process.argv[2] === "ls") &&
  process.argv.length === 3
) {
  const controller = new AbortController();
  try {
    if (process.argv[2] === "dev") {
      // Ctrl-C ou SIGTERM interrompem a App; aguardamos a limpeza do Postgres.
      const onInterrupt = () => controller.abort();
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onInterrupt);
      try {
        await dev(
          await loadConfig(),
          process.cwd(),
          undefined,
          undefined,
          controller.signal,
        );
      } finally {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onInterrupt);
      }
    } else console.log(await listProducts(process.cwd()));
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(
        error instanceof Error ? error.message : "Falha no comando.",
      );
      process.exitCode = 1;
    }
  }
} else if (
  process.argv[2] === "host" &&
  process.argv[3] === "bootstrap" &&
  process.argv.length === 5
) {
  try {
    process.exitCode = await bootstrap(process.argv[4]);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Falha no provisionamento.",
    );
    process.exitCode = 1;
  }
} else {
  console.error(
    "Uso: dangus dev | ls | doctor [--base <ref>] | render | deploy | host bootstrap <host>",
  );
  process.exitCode = 1;
}
