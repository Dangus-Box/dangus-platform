import { proxyAnalytics } from "../src/server";

const umami = process.env.UMAMI_URL;
const json = { "content-type": "application/json" };
const login = await fetch(`${umami}/api/auth/login`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ username: "admin", password: "umami" }),
});
if (!login.ok) throw new Error(`Login: ${login.status}`);
const auth = { ...json, authorization: `Bearer ${(await login.json()).token}` };
const site = await fetch(`${umami}/api/websites`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ name: "Product", domain: "produto.test" }),
});
if (!site.ok) throw new Error(`Create site: ${await site.text()}`);
const { id } = await site.json();

const product = Bun.serve({
  port: 0,
  async fetch(request) {
    return (
      (await proxyAnalytics(request, { websiteId: id, url: umami })) ??
      new Response("produto")
    );
  },
});
try {
  const browser =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
  const script = await fetch(new URL("/t.js", product.url), {
    headers: { "accept-encoding": "gzip, deflate, br", "user-agent": browser },
    decompress: false,
  });
  const encoding = script.headers.get("content-encoding");
  const raw = new Uint8Array(await script.arrayBuffer());
  // The browser decodes the body according to Content-Encoding.
  const decoded =
    encoding === "gzip" ? Bun.gunzipSync(raw) : encoding ? undefined : raw;
  if (!decoded) throw new Error(`Unexpected Content-Encoding: ${encoding}`);
  const text = new TextDecoder().decode(decoded);
  if (!script.ok || !text.includes("/api/e"))
    throw new Error(`Invalid tracker through Product (${encoding})`);
  console.log("Tracker served through Product domain OK");

  for (const ip of ["192.0.2.10", "192.0.2.10", "192.0.2.20"]) {
    const event = await fetch(new URL("/api/e", product.url), {
      method: "POST",
      headers: {
        ...json,
        "user-agent": browser,
        "x-forwarded-for": ip,
        cookie: "session=secret",
      },
      body: JSON.stringify({
        type: "event",
        payload: {
          website: id,
          hostname: "produto.test",
          url: "/via-product",
        },
      }),
    });
    if (!event.ok)
      throw new Error(`Event: ${event.status} ${await event.text()}`);
  }
  const now = Date.now();
  const range = `startAt=${now - 3600000}&endAt=${now + 60000}`;
  const stats = await (
    await fetch(`${umami}/api/websites/${id}/stats?${range}`, { headers: auth })
  ).json();
  if (stats.pageviews?.value !== 3 || stats.visitors?.value !== 2)
    throw new Error(
      `Pageviews and visitors by client IP: ${JSON.stringify(stats)}`,
    );
  console.log(
    "Event through Product recorded with visitor IP and User-Agent OK",
  );
} finally {
  product.stop();
}
