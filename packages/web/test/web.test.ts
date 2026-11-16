import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../src/index";
import { proxyAnalytics } from "../src/server";

test("analytics ausente não gera script ou acesso à rede", async () => {
  expect(renderToStaticMarkup(createElement(Analytics, {}))).toBe("");
  expect(
    (await proxyAnalytics(new Request("http://produto/t.js")))?.status,
  ).toBe(404);
});

test("script e coleta usam o domínio do Produto e preservam cabeçalhos", async () => {
  const requests: {
    path: string;
    userAgent: string | null;
    ip: string | null;
    body: string;
  }[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        userAgent: request.headers.get("user-agent"),
        ip: request.headers.get("x-forwarded-for"),
        body: await request.text(),
      });
      return new Response("ok");
    },
  });
  try {
    const html = renderToStaticMarkup(
      createElement(Analytics, { websiteId: "site" }),
    );
    expect(html).toContain('src="/t.js"');
    expect(html).not.toContain("analytics.dangus-box.com");
    const options = { websiteId: "site", url: upstream.url.href };
    expect(
      await (
        await proxyAnalytics(new Request("http://produto/t.js"), options)
      )?.text(),
    ).toBe("ok");
    expect(
      await (
        await proxyAnalytics(
          new Request("http://produto/api/e", {
            method: "POST",
            headers: {
              "user-agent": "browser",
              "x-forwarded-for": "192.0.2.1",
            },
            body: "event",
          }),
          options,
        )
      )?.text(),
    ).toBe("ok");
    expect(requests.map((r) => r.path)).toEqual(["/t.js", "/api/e"]);
    expect(requests[1]?.userAgent).toBe("browser");
    expect(requests[1]?.ip).toBe("192.0.2.1");
    expect(requests[1]?.body).toBe("event");
  } finally {
    upstream.stop();
  }
});

test("proxy não vaza cookies e cabeçalhos do Produto ao Umami", async () => {
  let received: Headers | undefined;
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      received = request.headers;
      return new Response("ok");
    },
  });
  try {
    await proxyAnalytics(
      new Request("http://produto/api/e", {
        method: "POST",
        headers: {
          cookie: "session=secreta",
          authorization: "Bearer secreto",
          "x-client-ip": "198.51.100.9",
          "accept-encoding": "gzip",
          "user-agent": "browser",
          "x-forwarded-for": "192.0.2.1",
          "x-umami-cache": "cache-token",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      { websiteId: "site", url: upstream.url.href },
    );
    expect(received?.get("cookie")).toBeNull();
    expect(received?.get("authorization")).toBeNull();
    expect(received?.get("x-client-ip")).toBeNull();
    expect(received?.get("user-agent")).toBe("browser");
    expect(received?.get("x-forwarded-for")).toBe("192.0.2.1");
    expect(received?.get("x-umami-cache")).toBe("cache-token");
    expect(received?.get("content-type")).toBe("application/json");
  } finally {
    upstream.stop();
  }
});

test("proxy encaminha apenas /t.js e /api/e ao Umami", async () => {
  const paths: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return new Response("ok");
    },
  });
  try {
    const options = { websiteId: "site", url: upstream.url.href };
    for (const path of [
      "/api/websites",
      "/t.js/../api/auth/login",
      "//evil.example/t.js",
      "/T.JS",
      "/api/e/",
    ])
      expect(
        await proxyAnalytics(new Request(`http://produto${path}`), options),
      ).toBeUndefined();
    expect(
      (
        await proxyAnalytics(
          new Request("http://produto/t.js", { method: "POST", body: "x" }),
          options,
        )
      )?.status,
    ).toBe(405);
    expect(paths).toEqual([]);
  } finally {
    upstream.stop();
  }
});
