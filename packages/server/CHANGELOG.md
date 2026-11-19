# @dangus-box/server

## 2.0.0-rc.1

### Patch Changes

- aa0e0d8: O doctor aceita como expand o `ALTER TABLE` que troca um CHECK: `DROP CONSTRAINT <nome>` seguido, no mesmo statement, de `ADD CONSTRAINT <mesmo nome> CHECK (...)` (com `NOT VALID` opcional), e `VALIDATE CONSTRAINT` não é sinalizado. Emite um aviso lembrando que o CHECK só pode ampliar, pois o linter não consegue provar isso. Qualquer outro `DROP` (coluna, tabela, constraint sem o mesmo nome, re-adição que não seja CHECK) continua falhando.

## 2.0.0-rc.0

### Mudanças incompatíveis

- Atualiza o SDK para Drizzle 1.0: `drizzle-orm` passa a ser peer dependency `^1.0.0-rc.4` (desenvolvimento fixado em `1.0.0-rc.4`). Atualize o ORM e converta as migrations com `drizzle-kit up` para o formato pasta por migration antes de atualizar o SDK.

  O migrator Postgres usa a API 1.0 sob advisory lock de sessão; SQLite lê as pastas oficiais sob `BEGIN IMMEDIATE`. O histórico existente é atualizado sem reaplicar migrations, mas ganha colunas: preserve todas as migrations aplicadas e faça Backup antes da atualização. Rollback de código não desfaz o schema nem esse upgrade do histórico.

## 1.0.0

### Major Changes

- 43de60c: Primeira publicação pública do Kit de Integração.
