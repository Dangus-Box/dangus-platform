import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main>Produto de exemplo</main>,
});
