export function validateEnvironment(env: Record<string, unknown>) {
  const days = Number(env.SESSION_TTL_DAYS ?? 7);
  if (!Number.isFinite(days) || days < 1 || days > 30) throw new Error('SESSION_TTL_DAYS inválido.');
  if (env.NODE_ENV !== 'production') return env;
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'FRONTEND_URL', 'FRONTEND_URLS', 'NATS_URL']) {
    if (typeof env[key] !== 'string' || !env[key] || /not-configured|troque-|changeme|CHANGE_ME|example\.test/.test(String(env[key]))) throw new Error(`Configuração de produção ausente/inválida: ${key}`);
  }
  if (String(env.JWT_SECRET).length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');
  const frontend = new URL(String(env.FRONTEND_URL));
  const callback = new URL(String(env.GOOGLE_CALLBACK_URL));
  if (frontend.protocol !== 'https:' || callback.protocol !== 'https:' || callback.origin !== frontend.origin || callback.pathname !== '/api/auth/google/callback') throw new Error('Origem/callback HTTPS inválidos.');
  for (const origin of String(env.FRONTEND_URLS).split(',')) {
    const parsed = new URL(origin.trim());
    if (parsed.protocol !== 'https:' || parsed.origin !== origin.trim() || /localhost|127\.0\.0\.1|\*/.test(origin)) throw new Error('Origem de produção inválida.');
  }
  if (env.EVENTS_ENABLED === 'true' && !(env.NATS_USER && env.NATS_PASSWORD)) throw new Error('Credenciais NATS obrigatórias em produção.');
  if (env.AUTH_TEST_MODE) throw new Error('Autenticação de teste indisponível em produção.');
  return env;
}
