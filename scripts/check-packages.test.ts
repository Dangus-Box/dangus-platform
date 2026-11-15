import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackage } from "./check-packages";

test("verifica o conteúdo empacotado e rejeita valores proibidos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-test-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    const file = join(dir, "index.js");
    await writeFile(file, "export const ok = true;");
    await expect(checkPackage(dir)).resolves.toBeUndefined();
    for (const value of [
      "192.0.2.42",
      "12345678-1234-1234-1234-123456789abc",
      `npm_${"x".repeat(36)}`,
    ]) {
      await writeFile(file, `// ${value}`);
      await expect(checkPackage(dir)).rejects.toThrow("Valor proibido");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
