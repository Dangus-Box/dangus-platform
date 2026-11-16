import { Analytics, Flags } from "@dangus-box/web";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const config = createServerFn({ method: "GET" }).handler(() => ({
  websiteId: process.env.UMAMI_WEBSITE_ID,
  token: process.env.FLAGS_FRONTEND_TOKEN,
}));

export const Route = createRootRoute({
  loader: () => config(),
  component: Root,
});
function Root() {
  const { websiteId, token } = Route.useLoaderData();
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
        <Analytics websiteId={websiteId} />
      </head>
      <body>
        <Flags token={token}>
          <Outlet />
        </Flags>
        <Scripts />
      </body>
    </html>
  );
}
