# Plataforma híbrida: Stack Ops compartilhada + Kit de Integração

A Plataforma não é um template copiado para cada Produto. Ela é uma Stack Ops que existe uma única vez (observabilidade, analytics, flags, destino dos backups) somada a um Kit de Integração versionado (CLI e SDK). Cada Produto apenas declara o que precisa na sua Config do Produto. Escolhemos isso porque templates copiados se distanciam do original e melhorias não chegam aos Produtos que já existem, enquanto centralizar a Stack Ops reduz custo e manutenção para um time de 1 a 3 pessoas.

## Considered Options

- **Template/boilerplate:** simples, mas cada cópia diverge e upgrades viram trabalho manual por Produto.
- **Só serviços compartilhados:** resolve observabilidade e analytics, mas deixa deploy, banco e backup para cada Produto refazer.
