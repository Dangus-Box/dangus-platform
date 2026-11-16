import { OpenFeature } from "@openfeature/server-sdk";
import { UnleashProvider } from "@unleash/openfeature-node-provider";

export async function configureFlags(appName: string): Promise<void> {
  const token = process.env.UNLEASH_TOKEN;
  if (!token) return;
  await OpenFeature.setProviderAndWait(
    new UnleashProvider({
      url: process.env.UNLEASH_URL || "http://dangus-ops-unleash:4242/api",
      appName,
      customHeaders: { Authorization: token },
    }),
  );
}
