import { validateEnvironment } from './production-config';
describe('Production configuration', () => {
  const valid = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://private/database', JWT_SECRET: 'a'.repeat(32), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_CALLBACK_URL: 'https://orfina.test/api/auth/google/callback', FRONTEND_URL: 'https://orfina.test', FRONTEND_URLS: 'https://orfina.test', NATS_URL: 'nats://private:4222', NATS_USER: 'publisher', NATS_PASSWORD: 'password', EVENTS_ENABLED: 'true' };
  it('requires HTTPS, exact origins and non-placeholder secrets', () => {
    expect(validateEnvironment(valid)).toEqual(valid);
    for (const override of [{ JWT_SECRET: 'short' }, { GOOGLE_CLIENT_SECRET: 'CHANGE_ME' }, { FRONTEND_URLS: '*' }, { GOOGLE_CALLBACK_URL: 'http://localhost/callback' }, { AUTH_TEST_MODE: 'true' }, { NATS_PASSWORD: '' }]) expect(() => validateEnvironment({ ...valid, ...override })).toThrow();
  });
});
