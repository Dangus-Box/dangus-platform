# @dangus-box/web

## 2.0.0-rc.1

### Patch Changes

- aa0e0d8: O doctor aceita como expand o `ALTER TABLE` que troca um CHECK: `DROP CONSTRAINT <nome>` seguido, no mesmo statement, de `ADD CONSTRAINT <mesmo nome> CHECK (...)` (com `NOT VALID` opcional), e `VALIDATE CONSTRAINT` não é sinalizado. Emite um aviso lembrando que o CHECK só pode ampliar, pois o linter não consegue provar isso. Qualquer outro `DROP` (coluna, tabela, constraint sem o mesmo nome, re-adição que não seja CHECK) continua falhando.

## 2.0.0-rc.0

### Mudanças incompatíveis

- Alinha a versão do SDK web ao Kit de Integração 2.0 pelo grupo de pacotes `linked`. Não há mudança de API web nesta versão; ao atualizar o conjunto, adapte o CLI e o SDK server às migrations do Drizzle 1.0, ao Postgres 18 e ao Registro com domínio próprio descritos nos respectivos changelogs.

## 1.0.0

### Major Changes

- 43de60c: Primeira publicação pública do Kit de Integração.
