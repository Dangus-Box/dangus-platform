# Stack Ops: observabilidade

O Alloy provisionado no Host envia logs ao Loki (retenção de 14 dias) e métricas ao Prometheus (30 dias) pela rede Docker `kamal`. O Grafana escuta apenas em `127.0.0.1:3300`; Loki e Prometheus não publicam portas. O dashboard Stack Ops filtra por Produto e apresenta requisições, erros, latência, CPU, RAM e logs. Grafana, Loki e Prometheus têm limites somados de 2176 MiB e 0,9 vCPU, reservando espaço para os demais serviços da Stack Ops.

## Deploy

No computador de operação, autentique `bws` com `BWS_ACCESS_TOKEN`, configure o SSH agent e guarde a senha do administrador no BWS com a chave `ops__GRAFANA_ADMIN_PASSWORD`. Execute `./infra/ops/deploy.sh` para iniciar os accessories pelo Kamal oficial; o Host padrão é `devbox-1`. Execute novamente o provisionamento do Host para atualizar o Alloy. Para atualizar accessories existentes, use `accessory reboot` pelo mesmo runner Kamal após revisar as alterações; accessories têm interrupção durante a atualização.

No console de administração Tailscale, crie o Tailscale Service `svc:ops` e autorize o Host a anunciá-lo. No Host execute manualmente:

```sh
tailscale serve --service=svc:ops --https=443 http://127.0.0.1:3300
```

Acesse a URL HTTPS do serviço na tailnet. O volume nomeado `dangus-ops-grafana` guarda os dados do Grafana e deverá ser incluído no Backup da issue #22; esta configuração não implementa Backup.
