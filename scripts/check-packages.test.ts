import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContent, checkPackage } from "./check-packages";

test("accepts loopback and 0.0.0.0 but rejects other IPv4 addresses", () => {
  expect(checkContent("listen 127.0.0.1:12345 and 0.0.0.0")).toBe(false);
  expect(checkContent("127.0.0.1 and 198.51.100.7")).toBe(true);
  expect(checkContent("10.0.0.1")).toBe(true);
});

test("checks packaged content and rejects forbidden values", async () => {
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
      await expect(checkPackage(dir)).rejects.toThrow("Forbidden value");
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

test("rejects secrets in template literals and Tailscale and Telegram tokens", async () => {
  for (const value of [
    "const token = `s3cr3t-value-123`;",
    `// tskey-auth-${"k".repeat(12)}-${"x".repeat(30)}`,
    `// 1234567890:${"A".repeat(35)}`,
  ]) {
    const dir = await fixture({}, value);
    try {
      await expect(checkPackage(dir)).rejects.toThrow("Forbidden value");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("rejects lifecycle scripts that change the package during publishing", async () => {
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
