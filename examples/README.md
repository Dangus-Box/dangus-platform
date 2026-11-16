# Produtos de exemplo

Dois Produtos independentes, com Apps em `apps/api` (Elysia), `apps/web` (TanStack Start) e `apps/mobile` (Expo). Cada variante usa Drizzle e integra o plugin de observabilidade de `@dangus-box/server`. As variantes têm instalações próprias e não fazem parte do workspace raiz.

Escolha `sqlite` ou `postgres` e execute os comandos dentro da respectiva pasta. Use `dangus dev` para iniciar a API e, na variante Postgres, seu banco local. A conexão padrão usa a porta 55432 e credenciais locais de exemplo; é possível usar outro banco com `DATABASE_URL`.

```sh
cd examples/sqlite # ou examples/postgres
bun install
../../node_modules/.bin/dangus dev
```

Em outro terminal, teste a escrita e a leitura:

```sh
curl -X POST http://localhost:3000/mensagens -H 'content-type: application/json' -d '{"texto":"Olá"}'
curl http://localhost:3000/mensagens
```

A API usa a porta 3000 por padrão; ajuste-a com `PORT=3001 bun dev`. Para iniciar a App web, execute `bun run dev:web` e acesse a URL exibida. Para a App mobile, execute `bun run dev:mobile` e siga as instruções do Expo. Execute `bun run test` para verificar a migration e a rota; na variante Postgres, inicie antes o banco com `docker compose up -d` (porta 55432) e pare-o depois com `docker compose down`. O SQLite cria `produto.sqlite` localmente. Ao encerrar a App, o comando para o Postgres local.

Cada variante instala `@dangus-box/server` diretamente de `../../packages/server` por uma dependência `file:`, pois está fora do workspace raiz. Execute `bun install` na raiz antes da instalação da variante. A API expõe `/health`, `/ready` e `/metrics`; as migrations rodam no boot antes de a API aceitar requisições e de a readiness ser marcada.

A Config do Produto SQLite declara `UNLEASH_TOKEN` e `UMAMI_WEBSITE_ID` como secrets da API. Para deploy, cadastre `exemplo-sqlite__UNLEASH_TOKEN` (token backend) e `exemplo-sqlite__UMAMI_WEBSITE_ID` no BWS. Localmente, sem essas variáveis, Flags usam valores padrão e analytics não envia eventos.

A App web SQLite usa `@dangus-box/web`: `UMAMI_WEBSITE_ID` ativa o script no domínio do Produto e `FLAGS_FRONTEND_TOKEN` ativa as Flags no Edge. Declare essas chaves no BWS como `exemplo-sqlite__UMAMI_WEBSITE_ID` e `exemplo-sqlite__FLAGS_FRONTEND_TOKEN`; a Config do Produto as entrega à App. O token frontend é público e chega ao navegador. Sem essas variáveis, o analytics fica desativado e as Flags usam os valores padrão. `UMAMI_URL` pode substituir o endereço interno padrão `http://dangus-ops-umami:3000` quando declarado também em `secrets`.
No exemplo SQLite, a App mobile usa `@dangus-box/native`. Para ativar analytics e Flags, declare no BWS `exemplo-sqlite__EXPO_PUBLIC_UMAMI_WEBSITE_ID` e `exemplo-sqlite__EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN`, ou exporte as variáveis `EXPO_PUBLIC_*` antes de iniciar o Expo localmente. O botão envia o evento `exemplo-mobile`; a Flag `versao-minima` controla a mensagem de atualização. Consulte `packages/native/README.md` para o formato do payload e a configuração do OpenFeature.
