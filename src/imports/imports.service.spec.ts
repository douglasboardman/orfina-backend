import { BadRequestException } from '@nestjs/common';
import { ImportsService } from './imports.service';

describe('ImportsService parser rules', () => {
  const service = new ImportsService({} as never, {} as never, {} as never);
  const internals = service as unknown as {
    parseCents(value: string): number;
    parseCsv(value: Buffer): Array<{ rowNumber: number; values: Record<string, string> }>;
    parseXlsx(value: Buffer): unknown;
    fingerprint(householdId: string, data: object): string;
  };

  it('parses quoted UTF-8 CSV fields and preserves row number', () => {
    expect(internals.parseCsv(Buffer.from('Data;Descrição;Valor\n02/10/2026;"Mercado, mensal";-12,34\n', 'utf8'))).toEqual([
      { rowNumber: 2, values: { data: '02/10/2026', descricao: 'Mercado, mensal', valor: '-12,34' } },
    ]);
  });

  it('converts money deterministically and rejects sub-cent precision', () => {
    expect(internals.parseCents('R$ 1.234,56')).toBe(123_456);
    expect(internals.parseCents('-0,01')).toBe(-1);
    expect(() => internals.parseCents('1.001')).toThrow(BadRequestException);
  });

  it('rejects a non-XLSX buffer and makes duplicate fingerprints insensitive to spacing', () => {
    expect(() => internals.parseXlsx(Buffer.from('not a zip'))).toThrow(BadRequestException);
    const a = internals.fingerprint('h1', { kind: 'TRANSACTION', occurredOn: '2026-10-02', amount: 100, description: 'Mercado  mensal', accountId: 'a1' });
    const b = internals.fingerprint('h1', { kind: 'TRANSACTION', occurredOn: '2026-10-02', amount: 100, description: 'mercado mensal', accountId: 'a1' });
    expect(a).toBe(b);
  });
});
