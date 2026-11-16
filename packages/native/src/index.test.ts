import { afterEach, expect, test } from "bun:test";
import {
  configurarFlags,
  enviarEvento,
  OpenFeature,
  precisaAtualizar,
} from "./index";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID;
  delete process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN;
  await OpenFeature.close();
});

test("sem configuração não acessa a rede e usa os padrões", async () => {
  globalThis.fetch = (() => {
    throw new Error("rede inesperada");
  }) as unknown as typeof fetch;
  await enviarEvento("evento");
  await configurarFlags("teste");
  expect(OpenFeature.getClient().getBooleanValue("flag", true)).toBe(true);
  expect(precisaAtualizar("1.0.0")).toBe(false);
});

test("evento contém website, nome e User-Agent", async () => {
  process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID = "site-teste";
  let request: Request | undefined;
  globalThis.fetch = ((input, init) => {
    request = new Request(input, init);
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  await enviarEvento("clique");
  expect(request?.url).toBe("https://analytics.dangus-box.com/api/send");
  expect(request?.headers.get("user-agent")).toContain("Mozilla/5.0");
  expect(await request?.json()).toEqual({
    type: "event",
    payload: {
      website: "site-teste",
      hostname: "app",
      url: "/",
      name: "clique",
    },
  });
});

test("payload de variante muda a Versão Mínima", async () => {
  process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN = "token-teste";
  let version = "1.0.0";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        toggles: [
          {
            name: "versao-minima",
            enabled: true,
            variant: {
              name: "minima",
              enabled: true,
              payload: { type: "string", value: version },
            },
          },
        ],
      }),
  });
  try {
    await configurarFlags("teste", server.url.href);
    expect(precisaAtualizar("1.0.0")).toBe(false);
    version = "1.1.0";
    await configurarFlags("teste", server.url.href);
    expect(precisaAtualizar("1.0.0")).toBe(true);
    expect(precisaAtualizar("1.2.0")).toBe(false);
  } finally {
    server.stop();
  }
});
