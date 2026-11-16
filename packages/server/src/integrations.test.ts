import { afterEach, expect, test } from "bun:test";
import { OpenFeature } from "@openfeature/server-sdk";
import { configureFlags, trackEvent } from "./index";

const original = { ...process.env };
afterEach(async () => {
  await OpenFeature.close();
  process.env = { ...original };
});

test("sem configuração, Flags retornam padrões e analytics não usa rede", async () => {
  delete process.env.UNLEASH_TOKEN;
  delete process.env.UMAMI_WEBSITE_ID;
  process.env.UNLEASH_URL = "http://127.0.0.1:1/api";
  process.env.UMAMI_URL = "http://127.0.0.1:1";
  await configureFlags("teste");
  const client = OpenFeature.getClient();
  expect(await client.getBooleanValue("flag", true)).toBe(true);
  expect(await client.getStringValue("config", "padrão")).toBe("padrão");
  await trackEvent({ name: "evento", hostname: "teste.local", url: "/" });
});

test("provider avalia Flag pelo OpenFeature usando Unleash local", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(
        `${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`,
      );
      if (new URL(request.url).pathname.endsWith("/client/features")) {
        return Response.json({
          version: 2,
          features: [
            {
              name: "ativa",
              enabled: true,
              strategies: [{ name: "default", parameters: {} }],
              variants: [],
            },
          ],
        });
      }
      return Response.json({});
    },
  });
  try {
    process.env.UNLEASH_TOKEN = "token-local";
    process.env.UNLEASH_URL = `${server.url}api`;
    await configureFlags("teste");
    expect(await OpenFeature.getClient().getBooleanValue("ativa", false)).toBe(
      true,
    );
    expect(requests).toContain("GET /api/client/features token-local");
  } finally {
    await OpenFeature.close();
    server.stop(true);
  }
});

test("analytics envia evento ao Umami configurado", async () => {
  let received: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/e");
      expect(request.headers.get("user-agent")).toContain("Mozilla");
      received = await request.json();
      return new Response("ok");
    },
  });
  try {
    process.env.UMAMI_WEBSITE_ID = "website-local";
    process.env.UMAMI_URL = server.url.toString();
    await trackEvent({
      name: "pedido",
      hostname: "teste.local",
      url: "/pedidos",
      data: { total: 3 },
    });
    expect(received).toEqual({
      type: "event",
      payload: {
        website: "website-local",
        name: "pedido",
        hostname: "teste.local",
        url: "/pedidos",
        data: { total: 3 },
      },
    });
  } finally {
    server.stop(true);
  }
});

test("Unleash lento não bloqueia o boot e Flags retornam padrões", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
  try {
    process.env.UNLEASH_TOKEN = "token-local";
    process.env.UNLEASH_URL = `${server.url}api`;
    const start = Date.now();
    await configureFlags("teste");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await OpenFeature.getClient().getBooleanValue("ativa", true)).toBe(
      true,
    );
  } finally {
    await OpenFeature.close();
    server.stop(true);
  }
}, 15000);

test("Umami lento, fora do ar ou com erro não rejeita nem bloqueia", async () => {
  const slow = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
  const failing = Bun.serve({
    port: 0,
    fetch: () => new Response("erro", { status: 500 }),
  });
  try {
    process.env.UMAMI_WEBSITE_ID = "website-local";
    for (const url of [slow.url, failing.url, "http://127.0.0.1:1"]) {
      process.env.UMAMI_URL = url.toString();
      const start = Date.now();
      await trackEvent({ name: "evento", hostname: "teste.local", url: "/" });
      expect(Date.now() - start).toBeLessThan(5000);
    }
  } finally {
    slow.stop(true);
    failing.stop(true);
  }
}, 20000);
