# @dangus-box/web

`Analytics` recebe `websiteId` e injeta o tracker em `/t.js`. A App deve encaminhar `/t.js` e `/api/e` para `proxyAnalytics` no servidor, passando `UMAMI_WEBSITE_ID` e, opcionalmente, `UMAMI_URL`. Encaminhe os cabeçalhos de IP do proxy reverso e User-Agent. Sem ID, as rotas retornam 404 e o componente não injeta script.

Envolva a árvore React em `Flags`, passando o token frontend obtido de `FLAGS_FRONTEND_TOKEN`. Use os hooks de `@openfeature/react-sdk` para avaliar Flags com valores padrão. Sem token, não há conexão com o Edge. O endereço padrão é `https://flags.dangus-box.com/api/frontend` e pode ser substituído pela propriedade `url` para testes locais. As Flags são atualizadas automaticamente sem rebuild.
