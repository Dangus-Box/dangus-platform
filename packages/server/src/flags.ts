import { OpenFeature } from "@openfeature/server-sdk";
import { UnleashProvider } from "@unleash/openfeature-node-provider";

const readyTimeoutMs = 3000;

export async function configureFlags(appName: string): Promise<void> {
  const token = process.env.UNLEASH_TOKEN;
  if (!token) return;
  const ready = OpenFeature.setProviderAndWait(
    new UnleashProvider({
      url: process.env.UNLEASH_URL || "http://dangus-ops-unleash:4242/api",
      appName,
      customHeaders: { Authorization: token },
    }),
  ).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise((resolve) => {
      timer = setTimeout(resolve, readyTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
