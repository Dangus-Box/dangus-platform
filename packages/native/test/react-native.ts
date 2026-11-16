// Substitui `react-native` fora do Metro: testes e e2e rodam no Bun.
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
