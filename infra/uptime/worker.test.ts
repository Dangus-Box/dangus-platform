import { expect, test } from "bun:test";
import { check } from "./worker.js";

const urls = [
  "https://analytics.dangus-box.com/api/heartbeat",
  "https://flags.dangus-box.com/internal-backstage/health",
];
function setup() {
  const data = new Map<string, string>();
  const messages: string[] = [];
  let status = 200;
  let timeout = false;
  const env = {
    UPTIME_KV: {
      async get(key: string) {
        return JSON.parse(data.get(key) ?? "null");
      },
      async put(key: string, value: string) {
        data.set(key, value);
      },
    },
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "test-chat",
  };
  const request = async (input: string, init?: RequestInit) => {
    if (input.startsWith("https://api.telegram.org/")) {
      messages.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true });
    }
    expect(urls).toContain(input);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (timeout) {
      await new Promise((resolve) =>
        init?.signal?.addEventListener("abort", resolve),
      );
      throw new Error("timeout");
    }
    return new Response(null, { status });
  };
  return {
    env,
    request,
    messages,
    data,
    setStatus(value: number) {
      status = value;
    },
    setTimeout(value: boolean) {
      timeout = value;
    },
  };
}

test("duas falhas consecutivas alertam uma vez e recuperação alerta uma vez", async () => {
  const f = setup();
  await check(f.env, f.request);
  f.setStatus(503);
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(0);
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(2);
  expect(f.messages.every((m) => m.startsWith("Indisponível:"))).toBe(true);
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(2);
  f.setStatus(200);
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(4);
  expect(f.messages.slice(2).every((m) => m.startsWith("Recuperado:"))).toBe(
    true,
  );
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(4);
});

test("sucesso entre falhas reinicia a contagem", async () => {
  const f = setup();
  f.setStatus(500);
  await check(f.env, f.request);
  f.setStatus(200);
  await check(f.env, f.request);
  f.setStatus(500);
  await check(f.env, f.request);
  expect(f.messages).toHaveLength(0);
});

test("timeout conta como falha", async () => {
  const f = setup();
  f.setTimeout(true);
  await check(f.env, f.request);
  expect(JSON.parse(f.data.get(urls[0]) ?? "null").failures).toBe(1);
}, 7000);
