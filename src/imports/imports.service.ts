import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountTransferStatus, CategoryType, ImportBatchStatus, ImportItemStatus, Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';

type Mapping = Partial<Record<'date' | 'description' | 'amount' | 'type' | 'category' | 'subcategory' | 'status' | 'account' | 'sourceAccount' | 'destinationAccount', string>>;
type PreviewInput = { fileName: string; contentBase64: string; mapping: Mapping; accountId?: string };
type ParsedRow = { rowNumber: number; values: Record<string, string> };
type ImportedData = {
  kind: 'TRANSACTION' | 'TRANSFER'; occurredOn: string; description: string; amount: number;
  status: 'PENDING' | 'POSTED'; type?: 'INCOME' | 'EXPENSE'; accountId?: string;
  sourceAccountId?: string; destinationAccountId?: string; categoryName?: string; subcategoryName?: string;
};

const MAX_BYTES = 2_000_000;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 60;
const MAX_CELLS = 100_000;

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService, private readonly households: HouseholdsService, private readonly events: EventsService) {}

  async list(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.importBatch.findMany({
      where: { householdId }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { _count: { select: { items: true } } },
    });
  }

  async get(userId: string, householdId: string, batchId: string) {
    await this.households.assertMember(userId, householdId);
    const batch = await this.prisma.importBatch.findFirst({ where: { id: batchId, householdId }, include: { items: { orderBy: { rowNumber: 'asc' } } } });
    if (!batch) throw new NotFoundException('Lote de importação não encontrado neste grupo familiar.');
    return batch;
  }

  async preview(userId: string, householdId: string, input: PreviewInput) {
    await this.households.assertCanManage(userId, householdId);
    const buffer = this.decodeContent(input.contentBase64);
    const sourceHash = createHash('sha256').update(buffer).digest('hex');
    const existing = await this.prisma.importBatch.findUnique({ where: { householdId_sourceHash: { householdId, sourceHash } }, include: { items: { orderBy: { rowNumber: 'asc' } } } });
    if (existing) return existing;

    const format = this.detectFormat(input.fileName, buffer);
    const mapping = Object.fromEntries(Object.entries(input.mapping).map(([field, header]) => [field, header ? this.normalizeHeader(header) : undefined])) as Mapping;
    let parsed: ParsedRow[];
    try {
      parsed = format === 'CSV' ? this.parseCsv(buffer) : this.parseXlsx(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Arquivo inválido.';
      return this.prisma.$transaction(async (tx) => {
        const batch = await tx.importBatch.create({ data: { householdId, createdById: userId, sourceHash, fileName: input.fileName, format, mapping: mapping as Prisma.InputJsonValue, status: ImportBatchStatus.FAILED, diagnostics: [{ code: 'INVALID_FILE', message }] } });
        await this.events.record(tx, { aggregateType: 'import-batch', aggregateId: batch.id, eventType: 'orfina.imports.batch-failed.v1', payload: { householdId, batchId: batch.id } });
        await this.audit(tx, householdId, userId, 'import-batch', batch.id, 'failed', ['format']);
        return batch;
      });
    }
    if (parsed.length > MAX_ROWS) throw new BadRequestException('O arquivo excede o limite de linhas permitido.');

    const accounts = await this.prisma.account.findMany({ where: { householdId, isActive: true }, select: { id: true, name: true } });
    const accountByName = new Map(accounts.map((account) => [this.normalize(account.name), account.id]));
    const accountIds = new Set(accounts.map((account) => account.id));
    if (input.accountId && !accountIds.has(input.accountId)) throw new NotFoundException('A conta de destino não pertence ao grupo familiar ou está arquivada.');
    const items: Array<{ rowNumber: number; status: ImportItemStatus; fingerprint: string; data: ImportedData; diagnostics: object[] }> = [];
    for (const row of parsed) {
      const resolved = this.resolveRow(row, mapping, input.accountId, accountByName);
      const fingerprint = resolved.data ? this.fingerprint(householdId, resolved.data) : createHash('sha256').update(`${householdId}:${sourceHash}:${row.rowNumber}`).digest('hex');
      let status: ImportItemStatus = resolved.diagnostics.length ? ImportItemStatus.INVALID : ImportItemStatus.VALID;
      if (resolved.data && !resolved.diagnostics.length) {
        const duplicate = await this.possibleDuplicate(householdId, fingerprint, resolved.data);
        if (duplicate) {
          status = ImportItemStatus.POSSIBLE_DUPLICATE;
          resolved.diagnostics.push({ code: 'POSSIBLE_DUPLICATE', message: 'Há uma movimentação semelhante já registrada; revise antes de confirmar.' });
        }
      }
      items.push({ rowNumber: row.rowNumber, status, fingerprint, data: resolved.data ?? { kind: 'TRANSACTION', occurredOn: '', description: '', amount: 0, status: 'POSTED' }, diagnostics: resolved.diagnostics });
    }
    const validCount = items.filter((item) => item.status === ImportItemStatus.VALID).length;
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          householdId, createdById: userId, sourceHash, fileName: input.fileName, format, mapping: mapping as Prisma.InputJsonValue,
          status: ImportBatchStatus.VALIDATED,
          diagnostics: { totalRows: items.length, validCount, invalidCount: items.length - validCount },
          items: { create: items.map((item) => ({ ...item, householdId, data: item.data as unknown as Prisma.InputJsonValue, diagnostics: item.diagnostics as unknown as Prisma.InputJsonValue })) },
        }, include: { items: { orderBy: { rowNumber: 'asc' } } },
      });
      await this.events.record(tx, { aggregateType: 'import-batch', aggregateId: batch.id, eventType: 'orfina.imports.batch-validated.v1', payload: { householdId, batchId: batch.id, itemCount: items.length } });
      await this.audit(tx, householdId, userId, 'import-batch', batch.id, 'validated', ['format', 'mapping']);
      return batch;
    });
  }

  async commit(userId: string, householdId: string, batchId: string, options: { createMissingCategories: boolean }) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.findFirst({ where: { id: batchId, householdId }, include: { items: { orderBy: { rowNumber: 'asc' } } } });
      if (!batch) throw new NotFoundException('Lote de importação não encontrado neste grupo familiar.');
      if (batch.status === ImportBatchStatus.COMMITTED) return batch;
      if (batch.status !== ImportBatchStatus.VALIDATED && batch.status !== ImportBatchStatus.DRAFT) throw new ConflictException('Este lote não pode mais ser confirmado.');
      const actionable = batch.items.filter((item) => item.status === ImportItemStatus.VALID);
      if (!actionable.length) throw new BadRequestException('Não há itens válidos para confirmar neste lote.');

      for (const item of actionable) {
        const data = item.data as unknown as ImportedData;
        if (data.kind === 'TRANSFER') {
          const accounts = await tx.account.count({ where: { householdId, isActive: true, id: { in: [data.sourceAccountId!, data.destinationAccountId!] } } });
          if (accounts !== 2 || data.sourceAccountId === data.destinationAccountId) throw new ConflictException('Uma conta de transferência deixou de ser válida para este grupo.');
          continue;
        }
        const account = await tx.account.findFirst({ where: { id: data.accountId, householdId, isActive: true }, select: { id: true } });
        if (!account) throw new ConflictException('A conta de um lançamento deixou de ser válida para este grupo.');
        const category = await tx.category.findUnique({ where: { householdId_name_type: { householdId, name: data.categoryName!, type: data.type as CategoryType } }, include: { subcategories: true } });
        if (!category && !options.createMissingCategories) throw new ConflictException('Há categorias ausentes. Revise a prévia e autorize sua criação explícita.');
        if (category && !category.subcategories.some((subcategory) => this.normalize(subcategory.name) === this.normalize(data.subcategoryName!))) throw new ConflictException('Há subcategorias ausentes. Revise a prévia e autorize sua criação explícita.');
      }

      for (const item of actionable) {
        const data = item.data as unknown as ImportedData;
        if (data.kind === 'TRANSFER') {
          const transfer = await tx.accountTransfer.create({ data: { householdId, sourceAccountId: data.sourceAccountId!, destinationAccountId: data.destinationAccountId!, amount: data.amount, occurredOn: this.civilDate(data.occurredOn), status: data.status as AccountTransferStatus, description: data.description, importItemId: item.id } });
          await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-created.v1', payload: { householdId, transferId: transfer.id, status: transfer.status } });
          await this.audit(tx, householdId, userId, 'transfer', transfer.id, 'imported', ['sourceAccountId', 'destinationAccountId', 'status']);
        } else {
          const { category, subcategory, created } = await this.categoryAndSubcategory(tx, householdId, userId, data, options.createMissingCategories);
          const transaction = await tx.transaction.create({ data: { householdId, accountId: data.accountId, categoryId: category.id, subcategoryId: subcategory.id, type: data.type as TransactionType, amount: data.amount, description: data.description, occurredOn: this.civilDate(data.occurredOn), status: data.status as TransactionStatus, importItemId: item.id } });
          await this.events.record(tx, { aggregateType: 'transaction', aggregateId: transaction.id, eventType: 'orfina.imports.item-committed.v1', payload: { householdId, batchId, itemId: item.id, transactionId: transaction.id, status: transaction.status } });
          await this.audit(tx, householdId, userId, 'transaction', transaction.id, 'imported', ['accountId', 'subcategoryId', 'status']);
          if (created) await this.audit(tx, householdId, userId, 'import-item', item.id, 'created-category-on-confirmation', ['category', 'subcategory']);
        }
        await tx.importItem.update({ where: { id: item.id }, data: { status: ImportItemStatus.COMMITTED, decidedById: userId, decidedAt: new Date() } });
      }
      const committed = await tx.importBatch.update({ where: { id: batchId }, data: { status: ImportBatchStatus.COMMITTED, committedAt: new Date() } });
      await this.events.record(tx, { aggregateType: 'import-batch', aggregateId: batchId, eventType: 'orfina.imports.batch-committed.v1', payload: { householdId, batchId, committedCount: actionable.length } });
      await this.audit(tx, householdId, userId, 'import-batch', batchId, 'committed', ['status']);
      return committed;
    });
  }

  async cancel(userId: string, householdId: string, batchId: string) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.findFirst({ where: { id: batchId, householdId } });
      if (!batch) throw new NotFoundException('Lote de importação não encontrado neste grupo familiar.');
      if (batch.status === ImportBatchStatus.COMMITTED) throw new ConflictException('Lotes confirmados não podem ser cancelados; uma reversão rastreável é necessária.');
      if (batch.status === ImportBatchStatus.CANCELED) return batch;
      const canceled = await tx.importBatch.update({ where: { id: batchId }, data: { status: ImportBatchStatus.CANCELED, canceledAt: new Date(), items: { updateMany: { where: { status: { not: ImportItemStatus.COMMITTED } }, data: { status: ImportItemStatus.CANCELED, decidedById: userId, decidedAt: new Date() } } } } });
      await this.events.record(tx, { aggregateType: 'import-batch', aggregateId: batchId, eventType: 'orfina.imports.batch-canceled.v1', payload: { householdId, batchId } });
      await this.audit(tx, householdId, userId, 'import-batch', batchId, 'canceled', ['status']);
      return canceled;
    });
  }

  private async categoryAndSubcategory(tx: Prisma.TransactionClient, householdId: string, userId: string, data: ImportedData, allowCreate: boolean) {
    let category = await tx.category.findUnique({ where: { householdId_name_type: { householdId, name: data.categoryName!, type: data.type as CategoryType } }, include: { subcategories: true } });
    let created = false;
    if (!category) {
      if (!allowCreate) throw new ConflictException('Categoria ausente.');
      category = await tx.category.create({ data: { householdId, name: data.categoryName!, type: data.type as CategoryType, color: data.type === 'INCOME' ? '#16803A' : '#C2410C', icon: 'receipt_long' }, include: { subcategories: true } });
      created = true;
      await this.events.record(tx, { aggregateType: 'category', aggregateId: category.id, eventType: 'orfina.categories.category-created.v1', payload: { householdId, categoryId: category.id, type: category.type } });
    }
    let subcategory = category.subcategories.find((entry) => this.normalize(entry.name) === this.normalize(data.subcategoryName!));
    if (!subcategory) {
      if (!allowCreate) throw new ConflictException('Subcategoria ausente.');
      subcategory = await tx.subcategory.create({ data: { categoryId: category.id, name: data.subcategoryName! } });
      created = true;
      await this.events.record(tx, { aggregateType: 'subcategory', aggregateId: subcategory.id, eventType: 'orfina.categories.subcategory-created.v1', payload: { householdId, categoryId: category.id, subcategoryId: subcategory.id, type: category.type } });
    }
    return { category, subcategory, created };
  }

  private async possibleDuplicate(householdId: string, fingerprint: string, data: ImportedData) {
    const imported = await this.prisma.importItem.findFirst({ where: { householdId, fingerprint, status: ImportItemStatus.COMMITTED }, select: { id: true } });
    if (imported) return true;
    if (data.kind === 'TRANSFER') return Boolean(await this.prisma.accountTransfer.findFirst({ where: { householdId, sourceAccountId: data.sourceAccountId, destinationAccountId: data.destinationAccountId, amount: data.amount, occurredOn: this.civilDate(data.occurredOn) }, select: { id: true } }));
    return Boolean(await this.prisma.transaction.findFirst({ where: { householdId, accountId: data.accountId, amount: data.amount, type: data.type as TransactionType, description: data.description, occurredOn: this.civilDate(data.occurredOn) }, select: { id: true } }));
  }

  private resolveRow(row: ParsedRow, mapping: Mapping, defaultAccountId: string | undefined, accountByName: Map<string, string>) {
    const get = (field: keyof Mapping, aliases: string[]) => row.values[mapping[field] ?? aliases.find((alias) => row.values[alias] !== undefined) ?? '']?.trim() ?? '';
    const diagnostics: Array<{ code: string; message: string }> = [];
    try {
      const occurredOn = this.parseDate(get('date', ['date', 'data', 'occurredon']));
      const description = get('description', ['description', 'descricao', 'histórico', 'historico']).slice(0, 160);
      if (description.length < 2) diagnostics.push({ code: 'DESCRIPTION_REQUIRED', message: 'Descrição ausente ou muito curta.' });
      const signedAmount = this.parseCents(get('amount', ['amount', 'valor', 'value']));
      if (!signedAmount) diagnostics.push({ code: 'AMOUNT_REQUIRED', message: 'O valor deve ser diferente de zero.' });
      const sourceName = get('sourceAccount', ['sourceaccount', 'origem', 'contaorigem']);
      const destinationName = get('destinationAccount', ['destinationaccount', 'destino', 'contadestino']);
      if (sourceName || destinationName) {
        const sourceAccountId = accountByName.get(this.normalize(sourceName)); const destinationAccountId = accountByName.get(this.normalize(destinationName));
        if (!sourceAccountId || !destinationAccountId) diagnostics.push({ code: 'UNKNOWN_ACCOUNT', message: 'Conta de origem ou destino não foi encontrada.' });
        if (sourceAccountId === destinationAccountId) diagnostics.push({ code: 'SAME_ACCOUNT_TRANSFER', message: 'A transferência exige contas diferentes.' });
        return { diagnostics, data: { kind: 'TRANSFER' as const, occurredOn, description, amount: Math.abs(signedAmount), status: this.parseStatus(get('status', ['status', 'situacao', 'situação'])), sourceAccountId, destinationAccountId } };
      }
      const accountName = get('account', ['account', 'conta']);
      const accountId = accountName ? accountByName.get(this.normalize(accountName)) : defaultAccountId;
      if (!accountId) diagnostics.push({ code: 'UNKNOWN_ACCOUNT', message: 'Selecione uma conta de destino ou informe uma conta válida no arquivo.' });
      const explicitType = get('type', ['type', 'tipo']);
      const type = this.parseType(explicitType, signedAmount);
      const categoryName = get('category', ['category', 'categoria']);
      const subcategoryName = get('subcategory', ['subcategory', 'subcategoria']);
      if (!categoryName || !subcategoryName) diagnostics.push({ code: 'CATEGORY_REQUIRED', message: 'Categoria e subcategoria são obrigatórias para um lançamento.' });
      return { diagnostics, data: { kind: 'TRANSACTION' as const, occurredOn, description, amount: Math.abs(signedAmount), status: this.parseStatus(get('status', ['status', 'situacao', 'situação'])), type, accountId, categoryName, subcategoryName } };
    } catch (error) {
      diagnostics.push({ code: 'INVALID_ROW', message: error instanceof Error ? error.message : 'Linha inválida.' });
      return { diagnostics, data: undefined };
    }
  }

  private parseCsv(buffer: Buffer): ParsedRow[] {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    if (text.includes('\uFFFD')) throw new BadRequestException('O CSV deve usar codificação UTF-8 válida.');
    const headerLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
    const delimiter = (headerLine.match(/;/g)?.length ?? 0) > (headerLine.match(/,/g)?.length ?? 0) ? ';' : ',';
    const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted && char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (!quoted && char === delimiter) { row.push(value); value = ''; }
      else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && text[index + 1] === '\n') index += 1; row.push(value); if (row.some((cell) => cell.trim())) rows.push(row); row = []; value = ''; }
      else value += char;
    }
    if (quoted) throw new BadRequestException('O CSV contém aspas não finalizadas.');
    if (value || row.length) { row.push(value); rows.push(row); }
    return this.tabularRows(rows);
  }

  private parseXlsx(buffer: Buffer): ParsedRow[] {
    const entries = this.zipEntries(buffer);
    if ([...entries.keys()].some((name) => name.includes('..') || name.startsWith('/') || name.includes('externalLinks') || name.endsWith('vbaProject.bin'))) throw new BadRequestException('A planilha contém conteúdo não permitido.');
    const sheet = entries.get('xl/worksheets/sheet1.xml');
    if (!entries.has('[Content_Types].xml') || !sheet) throw new BadRequestException('A planilha XLSX não contém uma primeira aba tabular válida.');
    if (sheet.includes('<f') || sheet.includes('http://') || sheet.includes('https://')) throw new BadRequestException('Planilhas com fórmulas ou links externos não são aceitas.');
    const shared = this.xmlValues(entries.get('xl/sharedStrings.xml') ?? '', 'si');
    const rows: string[][] = [];
    for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const reference = /\br="([A-Z]+)\d+"/.exec(cell[1])?.[1]; if (!reference) continue;
        const index = [...reference].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
        cells[index] = type === 's' ? (shared[Number(value)] ?? '') : type === 'inlineStr' ? this.xmlValues(cell[2], 'is')[0] ?? '' : this.decodeXml(value);
      }
      if (cells.some((cell) => cell?.trim())) rows.push(cells);
    }
    return this.tabularRows(rows);
  }

  private zipEntries(buffer: Buffer) {
    if (buffer.subarray(0, 4).toString('hex') !== '504b0304') throw new BadRequestException('O arquivo XLSX não possui uma estrutura ZIP válida.');
    const entries = new Map<string, string>(); let offset = 0; let totalUncompressed = 0;
    while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
      const flags = buffer.readUInt16LE(offset + 6); const method = buffer.readUInt16LE(offset + 8); const compressedSize = buffer.readUInt32LE(offset + 18); const uncompressedSize = buffer.readUInt32LE(offset + 22); const nameLength = buffer.readUInt16LE(offset + 26); const extraLength = buffer.readUInt16LE(offset + 28);
      if ((flags & 0x1) || (flags & 0x8) || ![0, 8].includes(method)) throw new BadRequestException('A planilha usa uma compactação não permitida.');
      if (!nameLength || compressedSize > MAX_BYTES || uncompressedSize > MAX_BYTES || (compressedSize && uncompressedSize / compressedSize > 100)) throw new BadRequestException('A planilha excede os limites seguros de compactação.');
      const start = offset + 30 + nameLength + extraLength; const end = start + compressedSize;
      if (end > buffer.length || entries.size >= 100) throw new BadRequestException('A estrutura da planilha é inválida ou excede limites.');
      totalUncompressed += uncompressedSize; if (totalUncompressed > MAX_BYTES * 3) throw new BadRequestException('A planilha excede o limite de conteúdo descompactado.');
      const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      const payload = buffer.subarray(start, end); const content = method === 0 ? payload : inflateRawSync(payload);
      if (content.length !== uncompressedSize) throw new BadRequestException('A planilha contém uma entrada ZIP inválida.');
      entries.set(name, content.toString('utf8')); offset = end;
    }
    return entries;
  }

  private tabularRows(rows: string[][]) {
    const headers = rows.shift()?.map((value) => this.normalizeHeader(value)) ?? [];
    if (!headers.length || headers.length > MAX_COLUMNS || !headers.every(Boolean)) throw new BadRequestException('A primeira linha deve conter cabeçalhos únicos e não vazios.');
    if (new Set(headers).size !== headers.length || rows.length * headers.length > MAX_CELLS) throw new BadRequestException('A tabela contém cabeçalhos duplicados ou células demais.');
    return rows.map((cells, index) => ({ rowNumber: index + 2, values: Object.fromEntries(headers.map((header, column) => [header, (cells[column] ?? '').trim()])) }));
  }

  private xmlValues(xml: string, tag: string) { return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((match) => this.decodeXml([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join(''))); }
  private decodeXml(value: string) { return value.replace(/&#(x[\da-fA-F]+|\d+);/g, (_, entity: string) => String.fromCodePoint(entity.startsWith('x') ? Number.parseInt(entity.slice(1), 16) : Number.parseInt(entity, 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
  private decodeContent(value: string) { const base64 = value.replace(/^data:[^;]+;base64,/, ''); if (!/^[A-Za-z0-9+/=]+$/.test(base64)) throw new BadRequestException('O conteúdo enviado não é Base64 válido.'); const buffer = Buffer.from(base64, 'base64'); if (!buffer.length || buffer.length > MAX_BYTES) throw new BadRequestException('O arquivo está vazio ou excede o limite de 2 MB.'); return buffer; }
  private detectFormat(name: string, buffer: Buffer) { const extension = name.toLowerCase().split('.').pop(); const zip = buffer.subarray(0, 4).toString('hex') === '504b0304'; if (extension === 'xlsx' && zip) return 'XLSX'; if (extension === 'csv' && !zip) return 'CSV'; throw new BadRequestException('Envie um CSV UTF-8 ou XLSX compatível com o conteúdo real do arquivo.'); }
  private parseDate(value: string) { if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value; const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value); if (br) return `${br[3]}-${br[2]}-${br[1]}`; if (/^\d+(\.\d+)?$/.test(value)) return new Date(Date.UTC(1899, 11, 30, 12) + Number(value) * 86_400_000).toISOString().slice(0, 10); throw new BadRequestException('A data deve usar AAAA-MM-DD, DD/MM/AAAA ou uma data tabular válida.'); }
  private parseCents(value: string) { const raw = value.replace(/[R$\s]/g, ''); const negative = raw.startsWith('-'); const unsigned = /^[+-]/.test(raw) ? raw.slice(1) : raw; const normalized = unsigned.includes(',') ? unsigned.replace(/\./g, '').replace(',', '.') : unsigned; if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new BadRequestException('O valor deve ter no máximo dois centavos.'); const [whole, fraction = ''] = normalized.split('.'); const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2)); if (!Number.isSafeInteger(cents) || cents > 999_999_999) throw new BadRequestException('O valor excede o limite permitido.'); return negative ? -cents : cents; }
  private parseType(value: string, amount: number): 'INCOME' | 'EXPENSE' { const normalized = this.normalize(value); if (['income', 'receita', 'credit', 'credito'].includes(normalized)) return 'INCOME'; if (['expense', 'despesa', 'debit', 'debito'].includes(normalized)) return 'EXPENSE'; return amount < 0 ? 'EXPENSE' : 'INCOME'; }
  private parseStatus(value: string): 'PENDING' | 'POSTED' { return ['pending', 'pendente'].includes(this.normalize(value)) ? 'PENDING' : 'POSTED'; }
  private fingerprint(householdId: string, data: ImportedData) { return createHash('sha256').update([householdId, data.kind, data.occurredOn, data.amount, this.normalize(data.description), data.accountId ?? data.sourceAccountId ?? '', data.destinationAccountId ?? ''].join('|')).digest('hex'); }
  private normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR'); }
  private normalizeHeader(value: string) { return this.normalize(value).replace(/[^a-z0-9]/g, ''); }
  private civilDate(value: string) { return new Date(`${value}T12:00:00.000Z`); }
  private audit(tx: Prisma.TransactionClient, householdId: string, actorId: string, aggregateType: string, aggregateId: string, action: string, changedFields: string[]) { return tx.auditLog.create({ data: { householdId, actorId, aggregateType, aggregateId, action, changedFields } }); }
}
