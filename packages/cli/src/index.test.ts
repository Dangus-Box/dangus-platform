import { expect, test } from "bun:test";
import { join } from "node:path";

const workspaceBin = join(import.meta.dir, "../../../node_modules/.bin/dangus");

test("exibe a versão do CLI pelo bin do workspace", async () => {
  const result = Bun.spawn([workspaceBin, "--version"], { stdout: "pipe" });
  expect(await new Response(result.stdout).text()).toBe("0.0.0\n");
  expect(await result.exited).toBe(0);
});
