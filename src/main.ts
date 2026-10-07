import { HttpErrorFilter } from './http-error.filter';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { allowedOrigins, CsrfGuard } from './auth/csrf.guard';

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

const rateLimit = async (request: { ip: string; url: string }, reply: { code(value: number): { send(body: unknown): unknown } }) => {
  const route = request.url.split('?')[0];
  const protectedRoute = route.startsWith('/api/admin') || route.startsWith('/api/auth/google') || route.startsWith('/api/imports') || route.includes('/imports');
  if (!protectedRoute) return;
  const windowMs = 60_000;
  const limit = route.startsWith('/api/admin') ? Number(process.env.ADMIN_RATE_LIMIT ?? 60) : route.startsWith('/api/auth/google') ? Number(process.env.OAUTH_RATE_LIMIT ?? 20) : Number(process.env.IMPORT_RATE_LIMIT ?? 30);
  const key = `${request.ip}:${route.startsWith('/api/admin') ? 'admin' : route.startsWith('/api/auth/google') ? 'oauth' : 'imports'}`;
  const now = Date.now();
  if (rateBuckets.size > 10000) { for (const [oldKey, old] of rateBuckets) if (old.resetAt <= now) rateBuckets.delete(oldKey); }
  if (rateBuckets.size > 20000 && !rateBuckets.has(key)) return reply.code(429).send({ code: 'RATE_LIMITED' });
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) return reply.code(429).send({ statusCode: 429, message: 'Limite de solicitações excedido. Tente novamente em instantes.' });
};

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',') : false }),
  );
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalGuards(app.get(CsrfGuard));
  app.getHttpAdapter().getInstance().addHook('onRequest', rateLimit);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
