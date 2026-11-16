const DEFAULT_UMAMI_URL = "http://dangus-ops-umami:3000";

export async function proxyAnalytics(
  request: Request,
  options: { websiteId?: string; url?: string } = {},
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/t.js" && path !== "/api/e") return undefined;
  if (!options.websiteId) return new Response(null, { status: 404 });
  if (
    (path === "/t.js" && request.method !== "GET") ||
    (path === "/api/e" && request.method !== "POST")
  )
    return new Response(null, { status: 405 });
  const headers = new Headers(request.headers);
  headers.delete("host");
  const target = new URL(
    path + new URL(request.url).search,
    options.url ?? DEFAULT_UMAMI_URL,
  );
  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
}
