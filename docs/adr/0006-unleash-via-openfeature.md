# Unleash OSS como servidor de Flags, acessado via OpenFeature

As Flags são servidas por um Unleash OSS self-hosted na Stack Ops, mas os Produtos nunca falam com o Unleash diretamente: o SDK da Plataforma expõe Flags pela API do OpenFeature (padrão da CNCF). O Unleash cobre o que precisamos (kill switch, rollout gradual, targeting e Remote Config via payload de variantes), é escrito em Node, usa Postgres e tem SDKs para servidor, React e React Native. O OpenFeature permite trocar de ferramenta sem mexer no código dos Produtos.

## Considered Options

- **Flagsmith:** Remote Config é recurso nativo, mas a stack é Django e parte dos recursos é enterprise.
- **GrowthBook:** focado em experimentos A/B, que estão fora do escopo, e exige MongoDB.
- **Tabela própria no banco:** acabaríamos reconstruindo rollout e targeting.

## Consequences

- O Unleash server fica só na rede interna do Host e no Tailscale (ADR-0009), e é por lá que o painel admin é acessado. O SDK de servidor fala com ele pela rede Docker.
- Web e mobile falam com um Unleash Edge, público em `flags.dangus-box.com`. O Edge é o caminho recomendado pela própria Unleash para tráfego de frontend, e expor o Unleash server diretamente exporia o painel admin junto.
- O Unleash OSS tem apenas o projeto `default`; Produtos compartilham esse projeto e o Ambiente `production`. Cada Produto recebe tokens próprios, revogáveis individualmente, mas o isolamento entre Produtos é uma convenção de nomes e constraints, não é imposto pelos tokens nem constitui uma fronteira de segurança.
