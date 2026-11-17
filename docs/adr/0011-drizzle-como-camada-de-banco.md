# Drizzle como camada de banco padrão dos Produtos

A Plataforma assume que os Produtos usam Drizzle ORM e drizzle-kit. A Plataforma precisa suportar tanto Postgres quanto SQLite, e o Drizzle é o que dá a mesma API para os dois (inclusive `bun:sqlite`). Isso também permite que o SDK execute migrations no boot (ADR-0007) e que o `dangus init` detecte o tipo de banco pela configuração do Drizzle. Um Produto que não use Drizzle fica fora do caminho suportado na v1.
