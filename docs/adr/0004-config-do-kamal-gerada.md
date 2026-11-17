# A configuração do Kamal é gerada a cada deploy, nunca versionada no Produto

O `deploy.yml` e os demais arquivos do Kamal são gerados a partir da Config do Produto a cada deploy, numa pasta temporária ignorada pelo git. O repositório do Produto não tem configuração do Kamal commitada. Assim, uma melhoria na Plataforma chega a todos os Produtos só com o bump da versão do CLI, que é o principal ganho do modelo híbrido (ADR-0001). Para depuração, `dangus render` mostra o resultado.

## Consequences

- Quem procurar `config/deploy.yml` no repositório do Produto não vai achar. Isso é intencional, não um esquecimento.
- Necessidades específicas de um Produto precisam caber na Config do Produto. Se não couberem, a Config do Produto é que deve ganhar a opção, em vez de se editar o arquivo gerado.
