import {
  configureFlags,
  needsUpdate,
  OpenFeature,
  OpenFeatureProvider,
  trackEvent,
  useFlag,
} from "@dangus-box/native";
import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";

function MinimumVersion() {
  useFlag("exemplo-sqlite.min-version", "");
  return (
    <Text>
      {needsUpdate("1.0.0", "exemplo-sqlite.min-version")
        ? "Update required"
        : "App up to date"}
    </Text>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    configureFlags(
      "exemplo-sqlite",
      undefined,
      process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN,
    ).finally(() => setReady(true));
  }, []);
  return (
    <OpenFeatureProvider client={OpenFeature.getClient()}>
      <View>
        <Text>Example Product</Text>
        {ready && <MinimumVersion />}
        <Button
          title="Send event"
          onPress={() =>
            void trackEvent(
              "exemplo-mobile",
              undefined,
              undefined,
              process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID,
            )
          }
        />
      </View>
    </OpenFeatureProvider>
  );
}
