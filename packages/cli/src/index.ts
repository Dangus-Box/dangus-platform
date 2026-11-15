#!/usr/bin/env bun
import { version } from "../package.json";

if (process.argv[2] === "--version") {
  console.log(version);
}
