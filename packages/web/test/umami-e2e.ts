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
  body: JSON.stringify({ name: "Produto", domain: "produto.test" }),
});
if (!site.ok) throw new Error(`Criar site: ${await site.text()}`);
const { id } = await site.json();

const produto = Bun.serve({
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
  const script = await fetch(new URL("/t.js", produto.url), {
    headers: { "accept-encoding": "gzip, deflate, br", "user-agent": browser },
    decompress: false,
  });
  const encoding = script.headers.get("content-encoding");
  const raw = new Uint8Array(await script.arrayBuffer());
  // O navegador decodifica o corpo conforme Content-Encoding.
  const decoded =
    encoding === "gzip" ? Bun.gunzipSync(raw) : encoding ? undefined : raw;
  if (!decoded) throw new Error(`Content-Encoding inesperado: ${encoding}`);
  const text = new TextDecoder().decode(decoded);
  if (!script.ok || !text.includes("/api/e"))
    throw new Error(`Tracker inválido pelo Produto (${encoding})`);
  console.log("Tracker servido pelo domínio do Produto OK");

  for (const ip of ["192.0.2.10", "192.0.2.10", "192.0.2.20"]) {
    const event = await fetch(new URL("/api/e", produto.url), {
      method: "POST",
      headers: {
        ...json,
        "user-agent": browser,
        "x-forwarded-for": ip,
        cookie: "session=secreta",
      },
      body: JSON.stringify({
        type: "event",
        payload: {
          website: id,
          hostname: "produto.test",
          url: "/",
          name: "pelo-produto",
        },
      }),
    });
    if (!event.ok)
      throw new Error(`Evento: ${event.status} ${await event.text()}`);
  }
  const now = Date.now();
  const range = `startAt=${now - 3600000}&endAt=${now + 60000}`;
  const events = await (
    await fetch(`${umami}/api/websites/${id}/events?${range}`, {
      headers: auth,
    })
  ).text();
  if (!events.includes("pelo-produto"))
    throw new Error(`Evento ausente: ${events}`);
  const stats = await (
    await fetch(`${umami}/api/websites/${id}/stats?${range}`, { headers: auth })
  ).json();
  if (stats.visitors?.value !== 2)
    throw new Error(`Visitantes por IP do cliente: ${JSON.stringify(stats)}`);
  console.log(
    "Evento pelo Produto registrado com IP e User-Agent do visitante OK",
  );
} finally {
  produto.stop();
}
