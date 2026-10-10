/** One pool per backend process; explicit deployment settings take precedence. */
export function databaseUrlWithPoolDefaults(raw: string | undefined) {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL inválida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL deve usar PostgreSQL.');
  for (const [name, fallback, minimum] of [['connection_limit', '5', 1], ['pool_timeout', '10', 0]] as const) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, fallback);
    const value = url.searchParams.get(name)!;
    if (url.searchParams.getAll(name).length !== 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
      throw new Error(`Parâmetro ${name} inválido em DATABASE_URL.`);
    }
  }
  return url.toString();
}
