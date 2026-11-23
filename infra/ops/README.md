# Stack Ops: observabilidade

O Alloy provisionado no Host envia logs ao Loki (retenção de 14 dias) e métricas ao Prometheus (30 dias) pela rede Docker `kamal`. O Grafana escuta apenas em `127.0.0.1:3300`; Loki e Prometheus não publicam portas. O dashboard Stack Ops filtra por Produto e apresenta requisições, erros, latência, CPU, RAM e logs. Grafana, Loki e Prometheus têm limites somados de 2176 MiB e 0,9 vCPU, reservando espaço para os demais serviços da Stack Ops.

## Deploy

No computador de operação, autentique `bws` com `BWS_ACCESS_TOKEN`, configure o SSH agent e guarde a senha do administrador no BWS com a chave `ops__GRAFANA_ADMIN_PASSWORD`. Execute `./infra/ops/deploy.sh` para iniciar os accessories pelo Kamal oficial; o Host padrão é `devbox-1`. Execute novamente o provisionamento do Host para atualizar o Alloy. Para atualizar accessories existentes, use `accessory reboot` pelo mesmo runner Kamal após revisar as alterações; accessories têm interrupção durante a atualização.

No console de administração Tailscale, crie o Tailscale Service `svc:ops` e autorize o Host a anunciá-lo. No Host execute manualmente:

```sh
tailscale serve --service=svc:ops --https=443 http://127.0.0.1:3300
```

Acesse a URL HTTPS do serviço na tailnet. O volume nomeado `dangus-ops-grafana` guarda os dados do Grafana e deverá ser incluído no Backup da issue #22; esta configuração não implementa Backup.

## Teste

Execute `infra/ops/test/stack-ops-e2e.sh` com Docker. Ele sobe a Stack Ops, o Alloy do provisionamento e o Produto de exemplo SQLite numa rede descartável e confere pelo Grafana logs, requisições, CPU, RAM e latência do Produto. O Docker local precisa usar a mesma configuração de armazenamento do Host.

## Analytics

O Umami atende em `https://analytics.dangus-box.com` pelo kamal-proxy. Seu Postgres não publica portas e usa o volume `dangus-ops-umami-db`, que deverá ser incluído no Backup da issue #22. Os limites dos dois accessories somam 768 MiB e 0,3 vCPU; com observabilidade, a Stack Ops usa até 2944 MiB e 1,2 vCPU, deixando espaço para a issue #14.

No projeto `ops` do BWS, preencha `ops__UMAMI_APP_SECRET`, `ops__UMAMI_DB_PASSWORD` e `ops__UMAMI_ADMIN_PASSWORD`, além da senha do Grafana. O deploy valida os secrets e substitui a senha inicial do administrador; não use `umami` como senha. Após o primeiro deploy, a senha no BWS deve continuar igual à senha no Umami. Para trocar a senha, atualize-a no painel e no BWS antes do próximo deploy. O script do tracker é `/t.js` e a coleta é `/api/e`; as issues #19 e #20 servirão esses caminhos pelo domínio de cada Produto.

O Umami não expira dados sozinho. O accessory `umami-retention` apaga, ao iniciar e depois a cada 24 h, eventos, dados de eventos, receitas, dados de sessão e sessões sem evento mais antigos que `UMAMI_RETENTION` (6 meses, o prazo que os Produtos publicam na política de privacidade). O resultado de cada execução vai para o log. Para verificar localmente, execute `infra/ops/test/umami-retention-e2e.sh`.

Para verificar localmente, execute `UMAMI_ADMIN_PASSWORD=<senha-de-teste> infra/ops/test/umami-e2e.sh`. O teste cria uma rede e um banco descartáveis e verifica login, tracker, evento pela API e evento enviado por `trackEvent` do `@dangus-box/server`. HTTPS e kamal-proxy precisam ser verificados no Host após o deploy.

## Flags

O Unleash server escuta somente em `127.0.0.1:4242` e na rede Docker `kamal`; o Postgres exclusivo usa o volume `dangus-ops-unleash-db`, que deverá ser incluído no Backup da issue #22. O Edge atende em `https://flags.dangus-box.com`. Os limites dos três accessories somam 1152 MiB e 0,3 vCPU.

No projeto `ops` do BWS, preencha `ops__UNLEASH_DB_PASSWORD`, `ops__UNLEASH_ADMIN_PASSWORD`, `ops__UNLEASH_FRONTEND_TOKEN` e `ops__UNLEASH_BACKEND_TOKEN`. Os tokens iniciais precisam seguir o formato `default:production.<segredo>` e ter segredos distintos e aleatórios. A senha e os tokens são inicializados apenas no primeiro boot do banco; mantenha-os sincronizados com o painel em alterações posteriores.

No console de administração Tailscale, crie o Tailscale Service `svc:flags-admin` e autorize o Host a anunciá-lo. No Host execute manualmente:

```sh
tailscale serve --service=svc:flags-admin --https=443 http://127.0.0.1:4242
```

Acesse o painel pela URL HTTPS do serviço na tailnet. Apps de servidor na rede Docker acessam `http://dangus-ops-unleash:4242/api` com token backend; frontend e mobile usam o Edge com token frontend.

O Unleash OSS usa o projeto `default` para todos os Produtos. Crie cada Flag com o prefixo `<produto>.`, por exemplo `exemplo-sqlite.min-version`, e, em `production`, acrescente a **todas** as estratégias uma constraint `appName IN ["exemplo-sqlite"]`, substituindo pelo nome da Config do Produto. Cada App deve iniciar o SDK com esse mesmo `appName`; para a web, passe `appName` ao componente `Flags`. Uma estratégia sem a constraint pode ativar a Flag para outro Produto, pois basta uma estratégia corresponder. Tokens são individuais e revogáveis, mas compartilham acesso ao projeto `default`: prefixos e `appName` são convenção, não uma barreira de segurança; clientes podem informar outro `appName`. O [schema de constraints do Unleash 6.9.1](https://github.com/Unleash/unleash/blob/v6.9.1/src/lib/openapi/spec/constraint-schema.ts) faz parte do código OSS.

Para verificar localmente, execute `infra/ops/test/unleash-e2e.sh`. O teste usa credenciais descartáveis, confere que uma Flag ligada e desligada é vista pelo OpenFeature com `configureFlags` do `@dangus-box/server`, sobe os containers com os limites configurados e remove a rede e os containers ao terminar. HTTPS e kamal-proxy precisam ser verificados no Host após o deploy.

## Alertas

O Grafana avalia o espaço disponível no filesystem raiz do Host a cada minuto e envia ao Telegram quando o uso passa de 85% por um minuto. No projeto `ops` do BWS, preencha `platform__TELEGRAM_BOT_TOKEN` e `platform__TELEGRAM_CHAT_ID`. O deploy recria o Grafana para aplicar regra, contato e token.

O uptime externo do Umami e do Unleash Edge é monitorado por um Cloudflare Worker; consulte `infra/tofu/README.md`. Produtos são adicionados na Adoção.

No Healthchecks.io, abra **Integrations → Telegram**, inicie a conexão e confirme interativamente no Telegram o grupo de destino. Os checks de Backup e de Verificação de Restore serão criados nas respectivas issues.

A entrega real no Telegram, incluindo o alerta ao parar o Umami e o limiar de 85% no Host, precisa ser verificada após o deploy.

Para testar a regra localmente, execute `infra/ops/test/alerts-e2e.sh`. Ele usa métricas e limiar de teste com Grafana e Prometheus descartáveis e captura a mensagem Telegram em um servidor HTTPS local.
