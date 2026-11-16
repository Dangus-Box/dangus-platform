import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContent, checkPackage } from "./check-packages";

test("aceita loopback e 0.0.0.0, mas rejeita outros IPv4", () => {
  expect(checkContent("listen 127.0.0.1:12345 e 0.0.0.0")).toBe(false);
  expect(checkContent("127.0.0.1 e 198.51.100.7")).toBe(true);
  expect(checkContent("10.0.0.1")).toBe(true);
});

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

async function fixture(
  manifest: Record<string, unknown>,
  source: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dangus-test-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", ...manifest }),
  );
  await writeFile(join(dir, "index.js"), source);
  return dir;
}

test("rejeita segredos em template literals e tokens do Tailscale e do Telegram", async () => {
  for (const value of [
    "const token = `s3cr3t-value-123`;",
    `// tskey-auth-${"k".repeat(12)}-${"x".repeat(30)}`,
    `// 1234567890:${"A".repeat(35)}`,
  ]) {
    const dir = await fixture({}, value);
    try {
      await expect(checkPackage(dir)).rejects.toThrow("Valor proibido");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("rejeita scripts de ciclo de vida que alteram o pacote na publicação", async () => {
  const dir = await fixture(
    { scripts: { prepublishOnly: "echo 192.0.2.42 > index.js" } },
    "export const ok = true;",
  );
  try {
    await expect(checkPackage(dir)).rejects.toThrow("prepublishOnly");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
