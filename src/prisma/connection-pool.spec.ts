import { databaseUrlWithPoolDefaults } from './connection-pool';

describe('database connection pool defaults', () => {
  it('bounds the pool and wait time while preserving connection options', () => {
    const url = new URL(databaseUrlWithPoolDefaults('postgresql://user:p%40ss@localhost/db?schema=family&sslmode=require')!);
    expect(url.searchParams.get('connection_limit')).toBe('5');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
    expect(url.password).toBe('p%40ss');
    expect(url.searchParams.get('schema')).toBe('family');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });

  it('preserves explicit valid deployment tuning', () => {
    const url = new URL(databaseUrlWithPoolDefaults('postgres://user:pass@localhost/db?connection_limit=3&pool_timeout=0')!);
    expect(url.searchParams.get('connection_limit')).toBe('3');
    expect(url.searchParams.get('pool_timeout')).toBe('0');
    expect(databaseUrlWithPoolDefaults(undefined)).toBeUndefined();
  });

  it.each(['connection_limit=0', 'connection_limit=-1', 'connection_limit=1.5', 'pool_timeout=-1', 'pool_timeout=abc', 'connection_limit=2&connection_limit=3', 'connection_limit=9007199254740992'])('rejects invalid %s without exposing credentials', (query) => {
    expect(() => databaseUrlWithPoolDefaults(`postgresql://user:secret@localhost/db?${query}`)).toThrow(/^Parâmetro (connection_limit|pool_timeout) inválido em DATABASE_URL\.$/);
  });

  it('rejects malformed URLs and other protocols', () => {
    expect(() => databaseUrlWithPoolDefaults('secret')).toThrow('DATABASE_URL inválida.');
    expect(() => databaseUrlWithPoolDefaults('mysql://user:secret@localhost/db')).toThrow('DATABASE_URL deve usar PostgreSQL.');
  });
});
