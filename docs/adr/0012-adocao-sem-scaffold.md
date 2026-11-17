# A Plataforma não faz Scaffold nem edita o código das Apps

O Scaffold do repositório de um Produto acontece fora da Plataforma. O `dangus init` só faz a Adoção de um Produto já estruturado: detecta as Apps por convenção (`apps/api` com Elysia, `apps/web` com TanStack Start, `apps/mobile` com Expo), gera a Config do Produto, os Dockerfiles e os workflows, e faz o Registro na Stack Ops. Ele não altera o código das Apps. As poucas linhas de integração do SDK são aplicadas à mão, e o `dangus doctor` confere se estão no lugar. Codemods sobre código que a Plataforma não controla são frágeis demais.

## Consequences

- Stacks diferentes de Elysia, TanStack Start e Expo não são suportadas na v1. Instruções para um agente de LLM adaptar a Adoção a outras stacks são trabalho futuro.
