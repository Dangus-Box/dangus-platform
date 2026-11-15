import { expect, test } from "bun:test";

test("exibe a versão do CLI", async () => {
  const result = Bun.spawn(
    ["bun", "run", "packages/cli/src/index.ts", "--version"],
    {
      stdout: "pipe",
    },
  );
  expect(await new Response(result.stdout).text()).toBe("0.0.0\n");
  expect(await result.exited).toBe(0);
});
