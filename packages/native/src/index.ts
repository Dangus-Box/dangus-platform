import { UnleashWebProvider } from "@openfeature/unleash-web-provider";
import { OpenFeature } from "@openfeature/web-sdk";
import { InMemoryStorageProvider } from "unleash-proxy-client";

export { OpenFeatureProvider, useFlag } from "@openfeature/react-sdk";
export { OpenFeature } from "@openfeature/web-sdk";

const analyticsUrl = "https://analytics.dangus-box.com";
const flagsUrl = "https://flags.dangus-box.com/api/frontend";
const userAgent =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

export async function enviarEvento(
  name: string,
  url = "/",
  servidor = analyticsUrl,
  website = process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID,
): Promise<void> {
  if (!website) return;
  await fetch(`${servidor}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({
      type: "event",
      payload: { website, hostname: "app", url, name },
    }),
  });
}

export async function configurarFlags(
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

export function precisaAtualizar(
  versaoAtual: string,
  flag = "versao-minima",
): boolean {
  const minima = OpenFeature.getClient().getStringValue(flag, "");
  const parse = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const atual = parse(versaoAtual);
  const requerida = parse(minima);
  if (!atual || !requerida) return false;
  for (let i = 0; i < 3; i++) {
    if (atual[i] !== requerida[i]) return atual[i] < requerida[i];
  }
  return false;
}
