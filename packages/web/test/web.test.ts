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
