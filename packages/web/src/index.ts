import { OpenFeature, OpenFeatureProvider } from "@openfeature/react-sdk";
import { UnleashWebProvider } from "@openfeature/unleash-web-provider";
import { createElement, type ReactNode, useEffect } from "react";

export function Analytics({ websiteId }: { websiteId?: string }) {
  return websiteId
    ? createElement("script", {
        defer: true,
        src: "/t.js",
        "data-website-id": websiteId,
      })
    : null;
}

export function Flags({
  token,
  appName = "web",
  url = "https://flags.dangus-box.com/api/frontend",
  children,
}: {
  token?: string;
  appName?: string;
  url?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (token)
      void OpenFeature.setProvider(
        new UnleashWebProvider({ url, clientKey: token, appName }),
      );
  }, [token, url, appName]);
  return createElement(OpenFeatureProvider, null, children);
}
