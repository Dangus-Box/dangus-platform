import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [tanstackStart(), react()],
  // @dangus-box/web uses file:; Vite follows the link to packages/web and
  // would duplicate the OpenFeature context and React.
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@openfeature/react-sdk",
      "@openfeature/web-sdk",
    ],
  },
});
