# Do projeto estruturado à produção

Siga na raiz do repositório do Produto. Este guia pressupõe a Stack Ops e o Host já provisionados. O [Produto SQLite](../examples/sqlite/) mostra uma integração completa; build e publicação mobile nas lojas ficam fora da v1.

## 1. Pré-requisitos

- Instale `bun`, Docker, `gh`, `tailscale` e o CLI `bws`. Conecte-se à tailnet e confirme com `tailscale status`. A política de referência permite `autogroup:member` acessar `*:*` e `tag:ci` acessar `tag:host:22`; o OAuth do CI precisa criar nós com `tag:ci`. Veja a [configuração da tailnet](../scripts/setup-external-accounts.sh) e confirme o acesso aos serviços `svc:ops` e `svc:flags-admin` com quem administra a tailnet.
- Exporte `BWS_ACCESS_TOKEN` de uma machine account `operator` com leitura no projeto `ops` e escrita em `prod`. O Registro precisa dos secrets de administração e Cloudflare descritos no [README do CLI](../packages/cli/README.md#config-do-produto), além da integração Telegram no Healthchecks.io. Para restore, o token precisa ler também os secrets de Backup em `ops` e `prod`. Use uma máquina confiável: o BWS CLI recebe valores em argumentos durante o Registro.
- O Produto já deve ter `apps/api` com Elysia, `apps/web` com TanStack Start e/ou `apps/mobile` com Expo, além de `drizzle.config.ts` na raiz com dialect `postgresql` ou `sqlite`. Use Drizzle para o banco e mantenha migrations em `drizzle/`. A Plataforma não cria a estrutura nem altera o código das Apps ([ADR-0012](adr/0012-adocao-sem-scaffold.md)).

## 2. Inicializar e registrar

Instale uma versão publicada exata do CLI e guarde `bun.lock`; substitua `<versão>` pela versão publicada escolhida:

```sh
bun add --dev --exact @dangus-box/cli@<versão>
bun run dangus init
```

Confirme as Apps e o banco detectados. Para execução sem perguntas use `bun run dangus init --yes`: arquivos existentes diferentes são preservados. O comando instala versões exatas do CLI e SDKs, gera `dangus.config.ts`, Dockerfiles para API e web, `.dockerignore`, `.github/workflows/deploy.yml` e `.github/workflows/restore.yml`, e adiciona `.dangus/` ao `.gitignore`. Revise os arquivos preservados e os domínios em `dangus.config.ts` antes de prosseguir. O nome deve conter apenas letras minúsculas, números e hífens; use domínios da zona Cloudflare configurada, com um nível de subdomínio.

```sh
bun run dangus register
```

O Registro cria ou reconhece o site no Umami quando há web, tokens backend e frontend no Unleash, checks de Backup e restore no Healthchecks.io, registros DNS A e AAAA e entradas de uptime; guarda as credenciais em `prod`. Divergências ou duplicatas interrompem o comando. Veja os detalhes e secrets necessários no [README do CLI](../packages/cli/README.md#config-do-produto). Para Postgres, crie também `<produto>__POSTGRES_PASSWORD` no BWS. Confirme os secrets de Backup compartilhados no [README de Backup](../infra/backup/README.md#backup-diário).

## 3. Integrar as Apps

Use o nome de `dangus.config.ts` como `appName`, substituindo `nome-do-produto` abaixo. O `init` mostra as linhas para as Apps detectadas; adapte-as às conexões e rotas existentes.

Na API, em `apps/api/index.ts`, inicialize observabilidade e migrations antes de escutar, integre o plugin e marque readiness após o boot. Exemplo SQLite (use a conexão `sqlite` já criada pela App):

```ts
import { configureFlags, migrateSqlite, observability, trackEvent } from "@dangus-box/server";
import { OpenFeature } from "@openfeature/server-sdk";

const observacao = observability();
migrateSqlite(sqlite, "./drizzle");
await configureFlags("nome-do-produto");
const flags = OpenFeature.getClient();
const ativa = await flags.getBooleanValue("nome-do-produto.minha-flag", false);
await trackEvent({ name: "pedido", hostname: "produto.com", url: "/pedidos" });
// Na construção do Elysia: .use(observacao.plugin)
// Após concluir o boot: observacao.markReady()
```

Para Postgres, importe `migratePostgres` no lugar de `migrateSqlite` e use `await migratePostgres(databaseUrl, "./drizzle")`, com a URL da conexão da App. Em SQLite, a conexão deve usar `process.env.SQLITE_PATH` para persistir no deploy. A API deve escutar na porta 3000. Veja [migrations e SDK de servidor](../packages/server/README.md).

Na raiz React da web, carregue `UMAMI_WEBSITE_ID` e `FLAGS_FRONTEND_TOKEN` no servidor e passe-os aos componentes; encaminhe `/t.js` e `/api/e` com `proxyAnalytics` antes das demais rotas. Use as implementações completas de [raiz React](../examples/sqlite/apps/web/src/routes/__root.tsx) e [servidor web](../examples/sqlite/apps/web/server.ts), trocando `exemplo-sqlite` pelo nome do Produto:

```tsx
import { Analytics, Flags } from "@dangus-box/web";

<Analytics websiteId={websiteId} />
<Flags token={token} appName="nome-do-produto"><Outlet /></Flags>
```

```ts
import { proxyAnalytics } from "@dangus-box/web/server";

const proxy = await proxyAnalytics(request, { websiteId: process.env.UMAMI_WEBSITE_ID });
if (proxy) return proxy;
```

Na mobile, passe as variáveis públicas do Expo a partir do código da App e envolva a árvore no provider. Veja a [App de exemplo](../examples/sqlite/apps/mobile/App.js) para o contexto React:

```tsx
import { configurarFlags, enviarEvento, OpenFeature, OpenFeatureProvider } from "@dangus-box/native";

await configurarFlags("nome-do-produto", undefined, process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN);
<OpenFeatureProvider client={OpenFeature.getClient()}>{/* App */}</OpenFeatureProvider>
await enviarEvento("evento", undefined, undefined, process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID);
```

As variáveis `EXPO_PUBLIC_*` precisam estar presentes no build Expo; são públicas. Os nomes de secrets por App são gerados em `dangus.config.ts`. Para avaliar Flags e Remote Config, consulte os READMEs de [servidor](../packages/server/README.md#flags-e-analytics), [web](../packages/web/README.md) e [mobile](../packages/native/README.md).

```sh
bun run dangus doctor
```

Corrija as falhas. O doctor verifica Config, integração básica da API, versão do CLI, Tailscale e migrations novas; não confirma a integração web/mobile nem o funcionamento de analytics e Flags. Ele compara migrations com `origin/main`; se necessário, disponibilize essa ref ou use `bun run dangus doctor --base <ref>`.

## 4. Primeiro deploy

Confirme que o Registro criou os DNS A e AAAA em modo DNS-only apontando para o Host. No GitHub do Produto, configure o secret `BWS_ACCESS_TOKEN` com leitura em `ops` e `prod`. Em `ops`, confirme `platform__TAILSCALE_OAUTH_CLIENT_ID`, `platform__TAILSCALE_OAUTH_CLIENT_SECRET`, `platform__DEPLOY_SSH_PRIVATE_KEY` e `platform__DEPLOY_SSH_KNOWN_HOSTS`; a chave SSH deve estar autorizada no Host e a identidade do Host verificada. A variável GitHub `DANGUS_HOST` é opcional; o padrão é `devbox-1`. Garanta que `GITHUB_TOKEN` possa publicar e ler imagens no GHCR. Consulte o [workflow de deploy](../packages/cli/README.md#workflow-de-deploy).

Versione os arquivos gerados, integrações e `bun.lock`, e envie o commit à `main`. Acompanhe **Actions → Deploy**: o push constrói e publica as imagens e executa o deploy. Acesse por HTTPS os domínios configurados; na API, acesse também `https://<domínio-da-api>/ready` e confirme resposta de sucesso. A web deve responder em `/`. Confira o recebimento de dados no passo 7.

## 5. Rollback

Em **Actions → Deploy → Run workflow**, informe no campo `sha` o SHA completo de um commit anterior da `main` que tenha imagens no GHCR e CLI com suporte a `deploy --skip-build`. O workflow usa o código, Config e CLI daquele commit, verifica as imagens e não faz novo build. Migrations devem ser aditivas; rollback não as desfaz. Como emergência existe `kamal rollback`, mas ele usa a configuração gerada atual; veja [ADR-0013](adr/0013-rollback-por-redeploy.md) e a [documentação de deploy](../packages/cli/README.md#render-e-deploy-de-apps).

## 6. Backup e restore

O Backup diário roda às 03:00 UTC. Para testar o mais recente em destino descartável, na raiz do Produto, com `bws`, `age`, `gzip`, `curl`, Docker e acesso aos secrets de Backup:

```sh
bun run dangus db restore
```

Para escolher objeto ou destino, use `--from <object-key>` ou `--target <DATABASE_URL|caminho>`; um destino explícito pede confirmação. Leia as precauções e dependências para Postgres e SQLite no [README de Backup](../infra/backup/README.md#restore-e-verificação-de-restore). O workflow **Verificação de Restore**, gerado no init, roda semanalmente e também aceita execução manual em Actions. Confira sua execução e o check de restore no Healthchecks.io; o workflow precisa do `BWS_ACCESS_TOKEN` e dos secrets de Backup.

## 7. Onde ver

- **Logs e métricas:** acesse a URL HTTPS de `svc:ops` na tailnet, abra o Grafana e filtre o dashboard Stack Ops pelo Produto.
- **Analytics:** acesse [Umami](https://analytics.dangus-box.com), abra o site do Produto e confirme eventos.
- **Flags:** acesse a URL HTTPS de `svc:flags-admin` na tailnet. No projeto `default`, crie Flags com prefixo `<produto>.` e constraint `appName IN ["<produto>"]` em todas as estratégias de `production`. Confira avaliação na App; prefixos e constraints são convenções, não isolamento de segurança. Veja [Flags na Stack Ops](../infra/ops/README.md#flags).
- **Alertas:** confira no Telegram os alertas de Backup/restore, uptime e disco. A entrega real deve ser verificada; veja [alertas](../infra/ops/README.md#alertas).

## Se travar

Execute `bun run dangus doctor` e revise as mensagens. Se o problema persistir, abra uma issue em [Dangus-Box/dangus-platform](https://github.com/Dangus-Box/dangus-platform/issues), descrevendo o passo e a mensagem sem incluir secrets.
