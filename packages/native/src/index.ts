import { UnleashWebProvider } from "@openfeature/unleash-web-provider";
import { OpenFeature } from "@openfeature/web-sdk";
import { Platform } from "react-native";
import { InMemoryStorageProvider } from "unleash-proxy-client";

export { OpenFeatureProvider, useFlag } from "@openfeature/react-sdk";
export { OpenFeature } from "@openfeature/web-sdk";

const analyticsUrl = "https://analytics.dangus-box.com";
const flagsUrl = "https://flags.dangus-box.com/api/frontend";
// Umami rejects bot UAs (such as the Android default `okhttp/…`); this minimal UA
// identifies only the system without pretending to be a browser.
const userAgent = () =>
  Platform.OS === "ios"
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X)"
    : "Mozilla/5.0 (Linux; Android)";

export async function trackEvent(
  name: string,
  url = "/",
  server = analyticsUrl,
  website = process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID,
): Promise<void> {
  if (!website) return;
  try {
    await fetch(`${server}/api/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent(),
      },
      body: JSON.stringify({
        type: "event",
        payload: { website, hostname: "app", url, name },
      }),
    });
  } catch {
    // Analytics never breaks the App, for example when offline.
  }
}

export async function configureFlags(
  appName: string,
  url = flagsUrl,
  clientKey = process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN,
): Promise<void> {
  if (!clientKey) return;
  await OpenFeature.setProviderAndWait(
    new UnleashWebProvider({
      url,
      clientKey,
      appName,
      storageProvider: new InMemoryStorageProvider(),
      disableMetrics: true,
    }),
  );
}

export function needsUpdate(
  currentVersion: string,
  flag = "min-version",
): boolean {
  const minimum = OpenFeature.getClient().getStringValue(flag, "");
  const parse = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const current = parse(currentVersion);
  const required = parse(minimum);
  if (!current || !required) return false;
  for (let i = 0; i < 3; i++) {
    if (current[i] !== required[i]) return current[i] < required[i];
  }
  return false;
}
