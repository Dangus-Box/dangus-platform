import { afterEach, expect, test } from "bun:test";
import { OpenFeature } from "@openfeature/server-sdk";
import { configureFlags, trackEvent } from "./index";

const original = { ...process.env };
afterEach(async () => {
  await OpenFeature.close();
  process.env = { ...original };
});

test("without configuration, Flags return defaults and analytics does not use the network", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return new Response("ok");
    },
  });
  try {
    delete process.env.UNLEASH_TOKEN;
    delete process.env.UMAMI_WEBSITE_ID;
    process.env.UNLEASH_URL = `${server.url}api`;
    process.env.UMAMI_URL = server.url.toString();
    await configureFlags("teste");
    const client = OpenFeature.getClient();
    expect(await client.getBooleanValue("flag", true)).toBe(true);
    expect(await client.getStringValue("config", "default")).toBe("default");
    await trackEvent({ name: "evento", hostname: "teste.local", url: "/" });
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("provider evaluates Flag through OpenFeature using local Unleash", async () => {
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
      expect(request.headers.get("user-agent")).toBe(
        "Mozilla/5.0 (X11; Linux x86_64) DangusPlatform/1.0",
      );
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

test("slow Unleash does not block boot and Flags return defaults", async () => {
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

test("slow, unavailable or failing Umami neither rejects nor blocks", async () => {
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
