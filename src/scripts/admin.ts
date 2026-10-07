import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';
import { operateAdmin, operatorSchema } from '../identity/admin-operator';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { email: { type: 'string' }, 'google-sub': { type: 'string' }, reason: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  const action = operatorSchema.shape.action.parse(positionals[0]);
  const prisma = new PrismaClient();
  try {
    console.log(`Operação administrativa: ${action}; ambiente: ${process.env.NODE_ENV ?? 'development'}; dry-run: ${values['dry-run']}`);
    console.log(await operateAdmin(prisma, { action, email: values.email, googleSub: values['google-sub'], reason: values.reason, dryRun: values['dry-run'] }));
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error && 'getResponse' in error ? (error as { getResponse(): unknown }).getResponse() : 'Operação recusada. Confira configuração e argumentos; nenhum segredo foi exibido.'); process.exitCode = 1; });
