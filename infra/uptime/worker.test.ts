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

test("consulta destinos configurados no KV", async () => {
  const f = setup();
  const target = "https://produto.example/ready";
  f.data.set("targets", JSON.stringify([target]));
  const checked: string[] = [];
  await check(f.env, async (url: string) => {
    checked.push(url);
    return new Response(null, { status: 200 });
  });
  expect(checked).toEqual([target]);
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

test("estado estável não grava no KV (limite de 1.000 gravações/dia no plano gratuito)", async () => {
  const f = setup();
  let writes = 0;
  const put = f.env.UPTIME_KV.put;
  f.env.UPTIME_KV.put = async (key: string, value: string) => {
    writes++;
    await put(key, value);
  };
  for (let i = 0; i < 3; i++) await check(f.env, f.request);
  f.setStatus(503);
  for (let i = 0; i < 5; i++) await check(f.env, f.request);
  const whileDown = writes;
  for (let i = 0; i < 5; i++) await check(f.env, f.request);
  expect(writes).toBe(whileDown);
  f.setStatus(200);
  await check(f.env, f.request);
  const afterRecovery = writes;
  for (let i = 0; i < 5; i++) await check(f.env, f.request);
  expect(writes).toBe(afterRecovery);
});

test("falha do Telegram não perde a transição nem repete alerta depois de enviado", async () => {
  const f = setup();
  let telegramUp = false;
  const request = async (input: string, init?: RequestInit) => {
    if (input.startsWith("https://api.telegram.org/") && !telegramUp)
      return Response.json({ ok: false }, { status: 502 });
    return f.request(input, init);
  };
  f.setStatus(503);
  await check(f.env, request).catch(() => {});
  await check(f.env, request).catch(() => {});
  await check(f.env, request).catch(() => {});
  expect(f.messages).toHaveLength(0);
  telegramUp = true;
  await check(f.env, request);
  expect(f.messages).toHaveLength(2);
  await check(f.env, request);
  expect(f.messages).toHaveLength(2);
});

test("falha de KV em uma URL não interrompe a verificação da outra", async () => {
  const f = setup();
  const get = f.env.UPTIME_KV.get;
  f.env.UPTIME_KV.get = async (key: string) => {
    if (key === urls[0]) throw new Error("KV indisponível");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return get(key);
  };
  f.setStatus(503);
  await expect(check(f.env, f.request)).rejects.toThrow();
  await expect(check(f.env, f.request)).rejects.toThrow();
  expect(f.messages).toEqual([`Indisponível: ${urls[1]}`]);
});
