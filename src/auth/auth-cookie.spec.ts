import { cookieName, serializeCookie } from './auth-cookie';
describe('Production cookie isolation', () => {
  const initial = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = initial; });
  it('uses host-prefixed secure cookies without Domain and with root Path', () => {
    process.env.NODE_ENV = 'production';
    const cookie = serializeCookie(cookieName('session'), 'fictional', 900);
    expect(cookie).toContain('__Host-orfina_session='); expect(cookie).toContain('Path=/;');
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).not.toContain('Domain=');
  });
  it('keeps the session proof readable but bound to the host', () => {
    process.env.NODE_ENV = 'production';
    const cookie = serializeCookie(cookieName('csrf'), 'fictional', 900, { httpOnly: false, path: '/' });
    expect(cookie).toContain('__Host-orfina_csrf='); expect(cookie).not.toContain('HttpOnly');
  });
});
