# Convenções de layout são padrões sobrescrevíveis na Config do Produto

A Config do Produto permite declarar, por App, `path`, `dockerfile`, `target`, `entry` e `healthcheckPath`, além de `migrations` no Produto. As chaves das Apps continuam sendo `api`, `web` e `mobile`; o layout não muda sua identidade.

Os padrões permanecem `apps/<app>`, `<path>/Dockerfile`, nenhum target, `<path>/index.ts`, `/ready` para API e `/` para web, e `drizzle` para migrations. Os caminhos são relativos à raiz do Produto, sem segmentos `..`. `dockerfile` e `entry` explícitos também partem dessa raiz, não de `path`.

Esta decisão emenda a [ADR-0012](0012-adocao-sem-scaffold.md): as convenções de detecção do `dangus init` continuam sendo o caminho automático, mas um Produto com layout próprio pode fazer a Adoção manualmente sem reorganizar suas Apps. A Plataforma continua sem fazer Scaffold nem editar seu código.

## Consequências

- O render usa o Dockerfile, o target opcional e o caminho de healthcheck declarados. A configuração do Kamal continua gerada, conforme a [ADR-0004](0004-config-do-kamal-gerada.md).
- O doctor lê a integração da API no `entry` e procura Migrations Aditivas em `migrations`.
- O Registro na Stack Ops usa o mesmo `healthcheckPath` nas URLs de uptime da API e da web.
- O Produto fornece seus Dockerfiles e endpoints de saúde; alterar a Config não cria esses arquivos nem altera as rotas da App.
- O contexto de build continua sendo a raiz do Produto, salvo a substituição já existente por `DANGUS_BUILD_CONTEXT`. Apps mobile continuam fora do deploy pelo Kamal.
