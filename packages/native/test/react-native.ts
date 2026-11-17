// Replace `react-native` outside Metro: tests and e2e run in Bun.
import { plugin } from "bun";

export const Platform = { OS: "android" };

plugin({
  name: "react-native",
  setup(build) {
    build.module("react-native", () => ({
      exports: { Platform },
      loader: "object",
    }));
  },
});
