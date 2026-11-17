---
status: accepted
---

# Hostinger com Host único na v1

Rodamos a Stack Ops e as Apps de todos os Produtos num único Host Hostinger KVM 4 (4 vCPU, 16 GB, datacenter no Brasil), com limites de CPU e RAM por container. A escolha é por custo e por ser o provedor que já usamos. O alvo continua sendo separar o Host Ops do Host de Apps: a migração acontece quando o primeiro Produto der certo, e a Plataforma não pode assumir nada que a impeça (por exemplo, endereços fixos de localhost entre Stack Ops e Apps).

## Consequences

- Se um Produto derrubar o Host, a observabilidade cai junto. Os limites de recursos (cerca de 4 GB de RAM e 1,5 vCPU reservados para a Stack Ops) existem para reduzir esse risco.
- A Hostinger não tem rede privada entre VPS nem object storage compatível com S3. A rede entre Hosts no futuro usa Tailscale (ADR-0009), e os Backups vão para o Cloudflare R2 (ADR-0008).
- O Provisionamento usa OpenTofu com o provider oficial `hostinger/hostinger`, e o state fica no R2 com a criptografia nativa do OpenTofu.
