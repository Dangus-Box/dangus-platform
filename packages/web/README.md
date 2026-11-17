# @dangus-box/web

`Analytics` recebe `websiteId` e injeta o tracker em `/t.js`. A App deve encaminhar `/t.js` e `/api/e` para `proxyAnalytics` no servidor, passando `UMAMI_WEBSITE_ID` e, opcionalmente, `UMAMI_URL`. A rota repassa ao Umami só `Content-Type`, `User-Agent`, `X-Forwarded-For` (definido pelo kamal-proxy) e `X-Umami-Cache`; cookies e credenciais do Produto não saem. Sem ID, as rotas retornam 404 e o componente não injeta script.

Envolva a árvore React em `Flags`, passando o token frontend obtido de `FLAGS_FRONTEND_TOKEN` e `appName` igual ao nome da Config do Produto. Use os hooks de `@openfeature/react-sdk` para avaliar Flags com valores padrão. Sem token, não há conexão com o Edge. O endereço padrão é `https://flags.dangus-box.com/api/frontend` e pode ser substituído pela propriedade `url` para testes locais. As Flags são atualizadas automaticamente sem rebuild. Sem `appName`, o padrão legado é `web`; informe o nome do Produto para atender às constraints das suas Flags.

Testes: `bun test packages/web`; com Docker, `infra/ops/test/web-umami-e2e.sh` (tracker e evento pela rota do Produto num Umami descartável) e `infra/ops/test/web-flags-e2e.sh` (Flag alterada no Unleash chega ao OpenFeature web).
