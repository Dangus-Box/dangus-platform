#!/usr/bin/env bun
import { version } from "../package.json";
import { bootstrap } from "./bootstrap";

if (process.argv[2] === "--version" && process.argv.length === 3) {
  console.log(version);
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
  console.error("Uso: dangus host bootstrap <host>");
  process.exitCode = 1;
}
