#!/usr/bin/env bun
import { version } from "../package.json";
import { bootstrap } from "./bootstrap";
import { doctor } from "./doctor";

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
    "Uso: dangus doctor [--base <ref>] | dangus host bootstrap <host>",
  );
  process.exitCode = 1;
}
