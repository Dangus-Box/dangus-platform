import { proxyAnalytics } from "@dangus-box/web/server";
import server from "./dist/server/server.js";

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const proxy = await proxyAnalytics(request, {
      websiteId: process.env.UMAMI_WEBSITE_ID,
      url: process.env.UMAMI_URL,
    });
    if (proxy) return proxy;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(`apps/web/dist/client${url.pathname}`);
      if (await file.exists()) return new Response(file);
    }
    return server.fetch(request);
  },
});
