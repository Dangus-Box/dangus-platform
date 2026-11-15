# dangus-platform

## Contas e credenciais externas

As contas de terceiros da Plataforma (Hostinger, Cloudflare/R2, Bitwarden Secrets Manager, Tailscale, Healthchecks.io, UptimeRobot, Telegram e npm) são criadas por um wizard interativo que guia cada passo e grava tudo no BWS:

```sh
scripts/setup-external-accounts.sh
```

Requer `gh` (com escopo `admin:org`), `jq`, `curl` e `bws`. Pode ser interrompido e retomado; use-o também para rotacionar credenciais.
