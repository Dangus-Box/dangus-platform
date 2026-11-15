# O Kit de Integração é publicado como pacotes públicos no npm

O CLI e o SDK são publicados no npm público, no escopo `@dangus-box`. Isso torna legível para qualquer pessoa o código dos pacotes publicados. O repositório em si pode continuar privado. O GitHub Packages exige token até para instalar, o que obrigaria todo repositório de Produto a configurar um token no `bunfig.toml`, no CI e na máquina de cada pessoa. Como o Kit de Integração não contém nada sensível (os secrets ficam no BWS, ADR-0005), expor o código dos pacotes custa menos que essa etapa a mais em cada Produto.

## Consequences

- Nada específico da Dangus Box que não possa ser público (IPs, nomes de Hosts, tokens, IDs do BWS) pode entrar no código dos pacotes. Esses valores vivem na Config do Produto, no BWS ou na pasta `infra/`, que não faz parte de nenhum pacote publicado.
