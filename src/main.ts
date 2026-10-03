import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { allowedOrigins, CsrfGuard } from './auth/csrf.guard';

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

const rateLimit = (request: { ip: string; url: string }, reply: { code(value: number): { send(body: unknown): unknown } }) => {
  const route = request.url.split('?')[0];
  const protectedRoute = route === '/api/auth/google' || route.startsWith('/api/imports') || route.includes('/imports');
  if (!protectedRoute) return;
  const windowMs = 60_000;
  const limit = route === '/api/auth/google' ? Number(process.env.OAUTH_RATE_LIMIT ?? 20) : Number(process.env.IMPORT_RATE_LIMIT ?? 30);
  const key = `${request.ip}:${route === '/api/auth/google' ? 'oauth' : 'imports'}`;
  const now = Date.now();
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
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalGuards(app.get(CsrfGuard));
  app.getHttpAdapter().getInstance().addHook('onRequest', rateLimit);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
