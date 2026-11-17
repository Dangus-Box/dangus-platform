import { afterEach, expect, test } from "bun:test";
import { Platform } from "../test/react-native";
import {
  configurarFlags,
  enviarEvento,
  OpenFeature,
  precisaAtualizar,
} from "./index";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  Platform.OS = "android";
  delete process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID;
  delete process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN;
  await OpenFeature.close();
});

test("without configuration, does not access the network and uses defaults", async () => {
  globalThis.fetch = (() => {
    throw new Error("rede inesperada");
  }) as unknown as typeof fetch;
  await enviarEvento("evento");
  await configurarFlags("teste");
  expect(OpenFeature.getClient().getBooleanValue("flag", true)).toBe(true);
  expect(precisaAtualizar("1.0.0")).toBe(false);
});

test("event contains website, name and User-Agent", async () => {
  process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID = "site-teste";
  let request: Request | undefined;
  globalThis.fetch = ((input, init) => {
    request = new Request(input, init);
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  await enviarEvento("clique");
  expect(request?.url).toBe("https://analytics.dangus-box.com/api/send");
  expect(request?.headers.get("user-agent")).toBe(
    "Mozilla/5.0 (Linux; Android)",
  );
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

test("variant payload changes the Minimum Version", async () => {
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

test("iOS User-Agent identifies the system without pretending to be a browser", async () => {
  Platform.OS = "ios";
  let userAgent: string | null | undefined;
  globalThis.fetch = ((_input, init) => {
    userAgent = new Headers(init?.headers).get("user-agent");
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  await enviarEvento("clique", "/", "http://umami", "site");
  expect(userAgent).toBe("Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X)");
});

test("analytics network failure does not reach the App", async () => {
  await enviarEvento("clique", "/", "http://127.0.0.1:1", "site");
});

async function minimumVersion(payload: unknown, currentVersion: string) {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        toggles: [
          {
            name: "versao-minima",
            enabled: true,
            variant: { name: "minima", enabled: true, payload },
          },
        ],
      }),
  });
  try {
    await configurarFlags("teste", server.url.href, "token-teste");
    return precisaAtualizar(currentVersion);
  } finally {
    server.stop(true);
  }
}

test("Minimum Version compares components numerically", async () => {
  const minimum = (value: string) => ({ type: "string", value });
  expect(await minimumVersion(minimum("1.10.0"), "1.9.0")).toBe(true);
  expect(await minimumVersion(minimum("1.9.0"), "1.10.0")).toBe(false);
  expect(await minimumVersion(minimum("2.0.0"), "1.99.99")).toBe(true);
  expect(await minimumVersion(minimum("1.2.3"), "1.2.3")).toBe(false);
});

test("missing or invalid payload does not require an update", async () => {
  for (const payload of [
    undefined,
    { type: "string", value: "" },
    { type: "string", value: "1.2" },
    { type: "string", value: "v2.0.0" },
    { type: "number", value: "2" },
    { type: "json", value: '{"versao":"2.0.0"}' },
  ])
    expect(await minimumVersion(payload, "1.0.0")).toBe(false);
});

test("unavailable Edge or rejected token does not require an update", async () => {
  await configurarFlags("teste", "http://127.0.0.1:1/api/frontend", "token");
  expect(precisaAtualizar("1.0.0")).toBe(false);
  for (const status of [401, 500]) {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("erro", { status }),
    });
    try {
      await configurarFlags("teste", server.url.href, "token");
      expect(precisaAtualizar("1.0.0")).toBe(false);
    } finally {
      server.stop(true);
    }
  }
});
