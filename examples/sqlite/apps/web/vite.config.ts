import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [tanstackStart(), react()],
  // @dangus-box/web vem por file:; o Vite segue o link até packages/web e
  // duplicaria o contexto do OpenFeature e o React.
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@openfeature/react-sdk",
      "@openfeature/web-sdk",
    ],
  },
});
