import {
  configurarFlags,
  enviarEvento,
  OpenFeature,
  OpenFeatureProvider,
  precisaAtualizar,
  useFlag,
} from "@dangus-box/native";
import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";

function MinimumVersion() {
  useFlag("exemplo-sqlite.versao-minima", "");
  return (
    <Text>
      {precisaAtualizar("1.0.0", "exemplo-sqlite.versao-minima")
        ? "Update required"
        : "App up to date"}
    </Text>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    configurarFlags(
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
            void enviarEvento(
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
