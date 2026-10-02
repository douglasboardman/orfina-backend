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
docker compose up -d
npm install
npx prisma migrate deploy
npm run start:dev
```

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `JWT_SECRET` e `FRONTEND_URL` no `.env`. Não versione esse arquivo.

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
