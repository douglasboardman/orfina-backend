# Orfina API

Backend da Orfina, aplicação de orçamento familiar. Implementado em NestJS, Fastify, Prisma, PostgreSQL e NATS JetStream.

## Capacidades

- Google OAuth e sessão JWT curta em cookie `HttpOnly`.
- Tenancy por grupo familiar, com papéis `OWNER`, `ADMIN`, `MEMBER` e `VIEWER`.
- Convites familiares pendentes, aceitos pela conta Google com o e-mail convidado.
- Contas, categorias, subcategorias e lançamentos com validação Zod.
- Valores monetários em centavos (`Int`) e subcategoria obrigatória.
- Outbox transacional com backoff, reconexão, falha persistida e métricas autenticadas.

## Execução local

```bash
cp .env.example .env
cd ..
docker compose up --build
```

O Compose da raiz constrói a API e o frontend, aguarda o PostgreSQL, aplica as
migrations e inicia os dois projetos. Configure `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` e `JWT_SECRET` no `.env`. Não
versione esse arquivo.

## Testes

```bash
npm test
npm run test:integration
npm run build
```

O teste de integração usa o Postgres do `.env`, cria dados isolados e os remove ao final.

## Massa local para testes manuais

Para importar uma exportação Excel e complementar o grupo com cartões, faturas, compra parcelada, recorrências, orçamento e metas, execute:

```bash
npm run seed:test-data -- /caminho/RELATORIO_TRANSACOES.xlsx --household-id <id-do-grupo> --actor-id <id-do-usuario>
```

A carga usa identificadores de origem e pode ser executada novamente sem duplicar os lançamentos importados. Transferências são materializadas como uma saída e uma entrada, pois ainda não há um agregado de transferência. A situação `Paga`/`Pendente` do arquivo é preservada nas notas do lançamento porque o modelo atual não possui status de liquidação.

## Eventos

Defina `EVENTS_ENABLED=true` para ativar NATS. Os controles de retentativa usam `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_BACKOFF_BASE_MS` e `OUTBOX_BACKOFF_MAX_MS`.

`GET /api/events/outbox/metrics` exige sessão e retorna a saúde da outbox.

## Conexões e produção

Todos os módulos importam `PrismaModule`, que fornece uma única instância de
`PrismaService` por processo backend. Não registre esse provider novamente em
módulos consumidores. Inicialização e encerramento conectam/desconectam o cliente
uma vez; transações de domínio e outbox continuam usando o mesmo Prisma.

O cliente acrescenta `connection_limit=5` e `pool_timeout=10` à `DATABASE_URL`
quando ausentes. Configurações explícitas válidas são preservadas: o primeiro
parâmetro limita conexões por processo e o segundo limita, em segundos, a espera
na fila do pool. Considere todos os processos ao dimensionar conexões; a VPS
atual executa uma única instância. A fila compartilha capacidade entre HTTP,
relay e recorrências. Aumentos futuros exigem medir carga e memória.

Produção usa Node/PM2, PostgreSQL, NATS e Caddy nativos. Artefatos glibc são
construídos na estação e somente diferenças verificadas são transferidas para
a VPS, sem build ou Docker no servidor. Antes do corte, o backup pg_dump age é
copiado para a estação e conferido. Consulte o
[runbook vigente](../deployment/NATIVE_RUNBOOK.md) para publicação e recuperação.
