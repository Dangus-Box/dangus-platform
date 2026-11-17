import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

let server: ReturnType<typeof Bun.spawn>;
const port = 18000 + Math.floor(Math.random() * 10000);
const url = `http://localhost:${port}/mensagens`;

beforeAll(async () => {
  server = Bun.spawn(["bun", "dev"], {
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("The API did not start");
});

afterAll(() => server?.kill());

test("the route writes and reads a message in the Product database", async () => {
  const text = `teste-${crypto.randomUUID()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texto: text }),
  });
  expect(response.status).toBe(200);
  expect((await response.json())[0].texto).toBe(text);
  const messages = await (await fetch(url)).json();
  expect(
    messages.some((message: { texto: string }) => message.texto === text),
  ).toBe(true);
});

test("the API exposes health, readiness, and metrics per route", async () => {
  const base = new URL(url).origin;
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/ready`)).status).toBe(200);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  expect(metrics).toContain('http_server_requests_total{route="/mensagens"');
});

test("migrations are up to date with the schema", async () => {
  const out = await mkdtemp(join(tmpdir(), "drizzle-"));
  await cp("drizzle", out, { recursive: true });
  const generate = Bun.spawn(
    [
      "bunx",
      "drizzle-kit",
      "generate",
      "--dialect=postgresql",
      "--schema=apps/api/schema.ts",
      `--out=${relative(process.cwd(), out)}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(generate.stdout).text();
  await rm(out, { recursive: true });
  expect(output).toContain("No schema changes");
}, 30_000);
