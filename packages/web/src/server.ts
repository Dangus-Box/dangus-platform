const DEFAULT_UMAMI_URL = "http://dangus-ops-umami:3000";
// Somente o que o Umami usa: tipo do corpo, visitante (IP e User-Agent) e
// token de sessão do tracker. Cookies e credenciais do Produto não saem.
const FORWARDED_HEADERS = [
  "content-type",
  "user-agent",
  "x-forwarded-for",
  "x-umami-cache",
];
const ROUTES: Record<string, string> = { "/t.js": "GET", "/api/e": "POST" };

export async function proxyAnalytics(
  request: Request,
  options: { websiteId?: string; url?: string } = {},
): Promise<Response | undefined> {
  const { pathname, search } = new URL(request.url);
  const method = ROUTES[pathname];
  if (!method) return undefined;
  if (!options.websiteId) return new Response(null, { status: 404 });
  if (request.method !== method) return new Response(null, { status: 405 });
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(
    new URL(pathname + search, options.url ?? DEFAULT_UMAMI_URL),
    {
      method,
      headers,
      body: method === "POST" ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "",
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
    },
  });
}
