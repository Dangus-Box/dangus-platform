# Um Banco do Produto por Produto, sem instância Postgres compartilhada

Cada Produto Postgres roda a sua própria instância de Postgres no Host, em vez de compartilhar uma instância com um banco por Produto. Isso garante versão independente, isolamento de carga, Backup separado e permite remover ou mover um Produto sem deixar sobras. O custo é cerca de 100 a 200 MB de RAM ociosa por instância, aceitável para até ~10 Produtos num Host de 16 GB.
