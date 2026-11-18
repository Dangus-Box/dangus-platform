#!/usr/bin/env bun
import { join } from "node:path";
import { version } from "../package.json";
import { bootstrap } from "./bootstrap";
import { loadConfig } from "./config";
import {
  backupNow,
  DEFAULT_HOST,
  deploy,
  productVersion,
  proxyBindIps,
  withRendered,
} from "./deploy";
import { dev } from "./dev";
import { doctor } from "./doctor";
import { init } from "./init";
import { listProducts } from "./ls";
import { register } from "./register";
import { parseRestoreArgs, restore } from "./restore";

if (process.argv[2] === "register" && process.argv.length === 3) {
  try {
    await register(process.cwd());
    console.log("Registration in the Ops Stack completed.");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Registration failed.",
    );
    process.exitCode = 1;
  }
} else if (process.argv[2] === "--version" && process.argv.length === 3) {
  console.log(version);
} else if (process.argv[2] === "doctor") {
  const args = process.argv.slice(3);
  if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1])) {
    console.error("Usage: dangus doctor [--base <ref>]");
    process.exitCode = 1;
  } else {
    const results = await doctor(process.cwd(), args[1]);
    for (const item of results) console.log(`[${item.status}] ${item.message}`);
    if (results.some((item) => item.status === "fail")) process.exitCode = 1;
  }
} else if (
  process.argv[2] === "init" &&
  (process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === "--yes"))
) {
  try {
    await init(process.cwd(), process.argv[3] === "--yes");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Adoption failed.");
    process.exitCode = 1;
  }
} else if (
  (process.argv[2] === "render" || process.argv[2] === "deploy") &&
  (process.argv.length === 3 ||
    (process.argv[2] === "deploy" &&
      process.argv.length === 4 &&
      process.argv[3] === "--skip-build"))
) {
  try {
    const config = await loadConfig();
    if (process.argv[2] === "deploy")
      await deploy(
        config,
        process.cwd(),
        undefined,
        undefined,
        process.argv[3] === "--skip-build",
      );
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
        undefined,
        await productVersion(),
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deploy failed.");
    process.exitCode = 1;
  }
} else if (
  process.argv[2] === "db" &&
  process.argv[3] === "backup" &&
  process.argv.length === 4
) {
  try {
    await backupNow(await loadConfig(), process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backup failed.");
    process.exitCode = 1;
  }
} else if (process.argv[2] === "db" && process.argv[3] === "restore") {
  try {
    await restore(await loadConfig(), parseRestoreArgs(process.argv.slice(4)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Restore failed.");
    process.exitCode = 1;
  }
} else if (
  (process.argv[2] === "dev" || process.argv[2] === "ls") &&
  process.argv.length === 3
) {
  const controller = new AbortController();
  try {
    if (process.argv[2] === "dev") {
      // Ctrl-C or SIGTERM stops the App; wait for Postgres cleanup.
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
      console.error(error instanceof Error ? error.message : "Command failed.");
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
      error instanceof Error ? error.message : "Provisioning failed.",
    );
    process.exitCode = 1;
  }
} else {
  console.error(
    "Usage: dangus init [--yes] | register | dev | ls | doctor [--base <ref>] | render | deploy [--skip-build] | db backup | db restore | host bootstrap <host>",
  );
  process.exitCode = 1;
}
