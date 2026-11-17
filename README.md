# dangus-platform

Para levar um Produto estruturado à produção, siga o [Guia de Adoção](docs/guide.md).

## Contas e credenciais externas

As contas de terceiros da Plataforma (Hostinger, Cloudflare/R2, Bitwarden Secrets Manager, Tailscale, Healthchecks.io, Telegram e npm) são criadas por um wizard interativo que guia cada passo e grava tudo no BWS:

```sh
scripts/setup-external-accounts.sh
```

Requer `gh` (com escopo `admin:org`), `jq`, `curl` e `bws`. Pode ser interrompido e retomado; use-o também para rotacionar credenciais.

## Publicação do Kit de Integração

Os quatro pacotes `@dangus-box` são públicos no npm. Para preparar uma versão,
registre as mudanças com `bunx changeset`, execute `bunx changeset version` e
inclua as versões e os changelogs resultantes na alteração revisada. A primeira
publicação já tem um changeset para os quatro pacotes. Depois de integrar a
alteração na branch principal, execute manualmente o workflow **Publish
packages**. Ele busca `platform__NPM_TOKEN` no projeto `ops` do BWS usando o
secret de organização `BWS_ACCESS_TOKEN` e a variável `BWS_SERVER_URL`.
O token npm precisa permitir publicar os quatro pacotes públicos.

Antes de publicar, `bun run check:packages` empacota cada pacote e verifica seu
conteúdo contra IPs, IDs do BWS e padrões comuns de tokens. A verificação também
roda no CI. Revise os arquivos empacotados: padrões automáticos não identificam
todos os valores sensíveis, inclusive nomes de Hosts. Um Produto pode fixar o
CLI com `bun add --exact @dangus-box/cli@<versão>` e versionar seu lockfile.
