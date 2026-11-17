# Rollback é refazer o deploy de um commit anterior, não `kamal rollback`

Para voltar uma versão, roda-se o workflow de deploy manualmente apontando para o SHA anterior. A imagem já está no GHCR, então o build é pulado. Não usamos o `kamal rollback` como caminho padrão porque, com a configuração gerada a cada deploy (ADR-0004), ele subiria a imagem antiga com a configuração gerada pela versão atual do CLI. Já o commit antigo traz o seu próprio `dangus.config.ts` e a sua versão do CLI fixada no lockfile, então configuração e imagem voltam juntas. O banco não precisa voltar porque as migrations são aditivas (ADR-0007).

## Consequences

- O `kamal rollback` continua existindo como recurso de emergência, e o guia documenta os dois caminhos.
- Cada Produto precisa fixar a versão do `@dangus-box/cli` no lockfile. Sem isso, o rollback perde a garantia.
