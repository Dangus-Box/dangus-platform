# Kamal 2 como mecanismo de deploy de Apps e da Stack Ops

Todo deploy, seja de App de Produto ou de serviço da Stack Ops, passa pelo Kamal 2. Ele dá deploy sem downtime via `kamal-proxy`, TLS automático com Let's Encrypt, vários apps no mesmo Host e configuração como código. O Kit de Integração executa o Kamal pela imagem Docker oficial, com a versão fixada no CLI, para que ninguém precise instalar Ruby e todos os Produtos usem a mesma versão.

## Considered Options

- **Dokploy/Coolify:** PaaS self-hosted com UI. Rejeitado porque a configuração fica no painel e não no repositório, o que conflita com a Config do Produto como fonte da verdade (ADR-0001), e a Plataforma viraria uma camada sobre outra plataforma.
- **Docker Compose + CLI própria via SSH:** obrigaria a reconstruir proxy, TLS, zero-downtime e rollback.
- **Kubernetes (k3s):** custo operacional alto demais para a escala (até ~10 Produtos, 1 a 3 pessoas).

## Consequences

- A Stack Ops é um único config Kamal (`dangus-ops`) em que todos os serviços são accessories. Os públicos (Umami e Unleash Edge) ficam atrás do `kamal-proxy` pela opção `proxy` dos accessories, suportada no Kamal 2.12. Antes de montar `infra/`, confirmar isso na versão do Kamal que for fixada.
- Accessories não têm deploy sem downtime, então atualizar a Stack Ops causa alguns segundos fora do ar. Aceitamos perder eventos do Umami nesse intervalo e servir Flags do cache dos SDKs durante a atualização.
