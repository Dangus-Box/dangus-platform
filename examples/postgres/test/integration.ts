import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.spawn>;
const port = 18000 + Math.floor(Math.random() * 10000);
const url = `http://localhost:${port}/mensagens`;

beforeAll(async () => {
  const migration = Bun.spawn(["bun", "run", "db:migrate"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  expect(await migration.exited).toBe(0);
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
  throw new Error("A API não iniciou");
});

afterAll(() => server?.kill());

test("a rota grava e lê uma mensagem no Banco do Produto", async () => {
  const texto = `teste-${crypto.randomUUID()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texto }),
  });
  expect(response.status).toBe(200);
  expect((await response.json())[0].texto).toBe(texto);
  const messages = await (await fetch(url)).json();
  expect(
    messages.some((message: { texto: string }) => message.texto === texto),
  ).toBe(true);
});

test("as migrations estão em dia com o schema", async () => {
  const out = await mkdtemp(join(tmpdir(), "drizzle-"));
  await cp("drizzle", out, { recursive: true });
  const generate = Bun.spawn(
    [
      "bunx",
      "drizzle-kit",
      "generate",
      "--dialect=postgresql",
      "--schema=apps/api/schema.ts",
      `--out=${out}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(generate.stdout).text();
  await rm(out, { recursive: true });
  expect(output).toContain("No schema changes");
}, 30_000);
