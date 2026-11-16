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

Para verificar localmente, execute `UMAMI_ADMIN_PASSWORD=<senha-de-teste> infra/ops/test/umami-e2e.sh`. O teste cria uma rede e um banco descartáveis e verifica login, tracker e evento pela API. HTTPS e kamal-proxy precisam ser verificados no Host após o deploy.
