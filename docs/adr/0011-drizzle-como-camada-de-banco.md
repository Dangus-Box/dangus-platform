# Drizzle como camada de banco padrão dos Produtos

A Plataforma assume que os Produtos usam Drizzle ORM e drizzle-kit. A Plataforma precisa suportar tanto Postgres quanto SQLite, e o Drizzle é o que dá a mesma API para os dois (inclusive `bun:sqlite`). Isso também permite que o SDK execute migrations no boot (ADR-0007) e que o `dangus init` detecte o tipo de banco pela configuração do Drizzle. Um Produto que não use Drizzle fica fora do caminho suportado na v1.

## Consequences

- A Plataforma usa Drizzle ORM e drizzle-kit `1.0.0-rc.4`, a versão adotada pelo Cofre a Dois. O SDK declara `drizzle-orm` como peerDependency `^1.0.0-rc.4`; cada Produto instala a versão compatível.
- Migrations usam `<timestamp>_<nome>/migration.sql` e `snapshot.json`. Produtos existentes devem executar `drizzle-kit up` antes de atualizar o SDK, preservando o SQL e o histórico.
- Postgres usa o migrator oficial com advisory lock de sessão, inclusive durante o upgrade do histórico.
- O migrator oficial bun-sqlite da rc.4 abre `BEGIN` internamente e não pode rodar dentro de `BEGIN IMMEDIATE`. O SDK mantém a execução SQLite sob esse lock, atualiza o histórico antigo por timestamp (segundos) ou hash e passa a identificar migrations pelo nome, como a rc.4. Histórico sem correspondência local interrompe o boot e reverte a transação.
- A continuidade foi comprovada com históricos criados por Drizzle 0.44.7 nos dois dialetos e com uma cópia consistente do Banco do Produto `exemplo-sqlite` do Host em 17/11/2026: dois boots preservaram dados e a única migration aplicada, inclusive com `id` nulo do SDK 1.0.0. Não é necessário resetar o volume. O upgrade acrescenta `name` e `applied_at`; não desfaz migrations.
