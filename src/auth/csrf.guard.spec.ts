import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();
  const context = (method: string, headers: Record<string, string>) => ({
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  });

  afterEach(() => { delete process.env.FRONTEND_URLS; });

  it('requires a matching double-submit token for mutations', () => {
    expect(() => guard.canActivate(context('POST', { cookie: 'orfina_csrf=one', 'x-orfina-csrf': 'two' }) as never)).toThrow(ForbiddenException);
    expect(guard.canActivate(context('POST', { cookie: 'orfina_csrf=one', 'x-orfina-csrf': 'one' }) as never)).toBe(true);
  });

  it('rejects browser mutations from an origin outside the allowlist', () => {
    process.env.FRONTEND_URLS = 'https://app.example.test';
    expect(() => guard.canActivate(context('PATCH', { cookie: 'orfina_csrf=one', 'x-orfina-csrf': 'one', origin: 'https://evil.example.test' }) as never)).toThrow(ForbiddenException);
  });
});
