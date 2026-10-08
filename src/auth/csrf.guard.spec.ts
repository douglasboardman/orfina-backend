import { CsrfGuard } from './csrf.guard';
import { hashCsrf } from './auth.service';
describe('CsrfGuard session binding', () => {
  const auth = { sessionFromToken: jest.fn(), sessionFromRefreshToken: jest.fn() }; const guard = new CsrfGuard(auth as never);
  const context = (headers: Record<string, string>, url = '/api/admin/access-grants') => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', url, headers }) }) });
  beforeEach(() => { process.env.FRONTEND_URLS = 'https://app.example.test'; auth.sessionFromToken.mockResolvedValue({ csrfTokenHash: hashCsrf('one') }); });
  afterEach(() => { delete process.env.FRONTEND_URLS; });
  it('accepts only the proof bound to the active session', async () => {
    await expect(guard.canActivate(context({ origin: 'https://app.example.test', cookie: 'orfina_csrf=one', 'x-orfina-csrf': 'one' }) as never)).resolves.toBe(true);
    await expect(guard.canActivate(context({ origin: 'https://app.example.test', cookie: 'orfina_csrf=forged', 'x-orfina-csrf': 'forged' }) as never)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects absent and foreign origin even with matching cookies', async () => {
    for (const origin of ['', 'https://evil.example.test']) await expect(guard.canActivate(context({ origin, cookie: 'orfina_csrf=one', 'x-orfina-csrf': 'one' }) as never)).rejects.toMatchObject({ status: 403 });
  });
  it('permits local cookie cleanup on logout after session expiration', async () => {
    auth.sessionFromToken.mockResolvedValue(null);
    await expect(guard.canActivate(context({ origin: 'https://app.example.test' }, '/api/auth/logout') as never)).resolves.toBe(true);
  });
});
