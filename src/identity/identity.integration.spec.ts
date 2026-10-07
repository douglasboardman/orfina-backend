import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient, User } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { CsrfGuard } from '../auth/csrf.guard';
import { AdminService } from './admin.service';
import { operateAdmin } from './admin-operator';
import { HttpErrorFilter } from '../http-error.filter';
import { GoogleIdentityService } from '../auth/google.strategy';

const integration = process.env.ORFINA_IDENTITY_TEST === '1' && /_(delivery11|test)$/.test(new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/none').pathname) ? describe : describe.skip;
integration('System administration (isolated PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString();
  let app: NestFastifyApplication; let auth: AuthService; let admin: AdminService;
  let owner: User; let member: User; let actor: { id: string; sessionId: string };
  let ownerCookie = ''; let ownerCsrf = ''; let memberCookie = ''; let memberCsrf = '';
  const origin = 'http://localhost:4200';
  const profile = (id: string, email: string) => ({ googleId: id, email, emailVerified: true, name: 'Fictitious tester' });
  const mutation = (cookie: string, csrf: string) => ({ cookie, origin, 'x-orfina-csrf': csrf });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret-for-isolated-integration-only'; process.env.EVENTS_ENABLED = 'false'; process.env.FRONTEND_URLS = origin;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.setGlobalPrefix('api'); app.useGlobalGuards(app.get(CsrfGuard)); app.useGlobalFilters(new HttpErrorFilter()); await app.init();
    await app.getHttpAdapter().getInstance().ready(); auth = app.get(AuthService); admin = app.get(AdminService);
    // This suite is only enabled for an explicitly selected disposable database.
    await prisma.accessGrant.updateMany({ where: { user: { is: { systemRole: 'SYSTEM_ADMIN' } } }, data: { status: 'DISABLED' } });
    const email = `admin-${suffix}@gmail.com`; const googleSub = `91${suffix}`;
    await prisma.user.create({ data: { email, googleId: googleSub, name: 'Admin fixture', systemRole: 'SYSTEM_ADMIN', accessGrant: { create: { email, normalizedEmail: email, source: 'BOOTSTRAP' } } } });
    owner = await prisma.user.findUniqueOrThrow({ where: { googleId: googleSub } });
    const session = await auth.signInWithGoogle(profile(googleSub, email)); actor = { id: owner.id, sessionId: session.session.id };
    ownerCookie = `orfina_session=${session.token}; orfina_csrf=${session.csrf}`; ownerCsrf = session.csrf;
    member = await prisma.user.create({ data: { email: `member-${suffix}@gmail.com`, name: 'Member', googleId: `92${suffix}` } });
    await prisma.accessGrant.create({ data: { email: member.email, normalizedEmail: member.email, userId: member.id } });
    const memberSession = await auth.signInWithGoogle(profile(member.googleId!, member.email));
    memberCookie = `orfina_session=${memberSession.token}; orfina_csrf=${memberSession.csrf}`; memberCsrf = memberSession.csrf;
  });
  afterAll(async () => {
    if (app) await app.close();
    const users = await prisma.user.findMany({ where: { email: { contains: suffix } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.household.deleteMany({ where: { members: { some: { userId: { in: ids } } } } });
    await prisma.accessGrant.deleteMany({ where: { OR: [{ normalizedEmail: { contains: suffix } }, { userId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('bootstrap is idempotent and cannot silently replace an administrator', async () => {
    await expect(operateAdmin(prisma, { action: 'bootstrap', email: owner.email, googleSub: owner.googleId! })).resolves.toMatchObject({ unchanged: true });
    await expect(operateAdmin(prisma, { action: 'bootstrap', email: `other-${suffix}@gmail.com`, googleSub: `93${suffix}` })).rejects.toMatchObject({ status: 409 });
  });
  it('refuses unlisted/unverified users without creating their profiles or sessions', async () => {
    const email = `unknown-${suffix}@gmail.com`;
    await expect(auth.signInWithGoogle(profile(`94${suffix}`, email))).rejects.toMatchObject({ status: 403 });
    await expect(auth.signInWithGoogle({ ...profile('999', email), emailVerified: false })).rejects.toMatchObject({ status: 403 });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });
  it('links an allowed Google identity exactly once under concurrent callbacks', async () => {
    const email = `new-${suffix}@gmail.com`; const grant = await admin.create(actor, { email });
    await Promise.all([auth.signInWithGoogle(profile(`95${suffix}`, email)), auth.signInWithGoogle(profile(`95${suffix}`, email))]);
    expect(await prisma.user.count({ where: { googleId: `95${suffix}` } })).toBe(1);
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id } })).userId).not.toBeNull();
    await expect(auth.signInWithGoogle(profile(`96${suffix}`, email))).rejects.toMatchObject({ status: 403 });
  });
  it('requires explicit identity binding for external e-mail and legacy profiles', async () => {
    const email = `external-${suffix}@example.test`; await admin.create(actor, { email });
    await expect(auth.signInWithGoogle(profile(`97${suffix}`, email))).rejects.toMatchObject({ status: 403 });
    await operateAdmin(prisma, { action: 'bind', email, googleSub: `97${suffix}`, reason: 'Identity checked by operator' });
    await expect(auth.signInWithGoogle(profile(`97${suffix}`, email))).resolves.toHaveProperty('session');
    const legacyEmail = `legacy-${suffix}@gmail.com`; await prisma.user.create({ data: { email: legacyEmail, name: 'Legacy', googleId: `98${suffix}` } });
    await admin.create(actor, { email: legacyEmail });
    await expect(auth.signInWithGoogle(profile(`98${suffix}`, legacyEmail))).rejects.toMatchObject({ status: 403 });
  });
  it('does not expose session identifiers and does not trust role claims in JWT', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } });
    expect(me.statusCode).toBe(200); expect(me.json()).toMatchObject({ systemRole: 'SYSTEM_ADMIN' }); expect(me.json()).not.toHaveProperty('sessionId');
    const sid = (await prisma.session.findFirstOrThrow({ where: { userId: member.id, revokedAt: null } })).id;
    const forgedRole = app.get(JwtService).sign({ sub: member.id, sid, systemRole: 'SYSTEM_ADMIN' });
    const response = await app.inject({ method: 'GET', url: '/api/admin/access-grants', headers: { cookie: `orfina_session=${forgedRole}` } });
    expect(response.statusCode).toBe(403);
  });
  it('denies all administrative endpoints to a household administrator', async () => {
    await prisma.household.create({ data: { name: 'Fictitious group', members: { create: { userId: member.id, role: 'ADMIN' } } } });
    for (const url of ['/api/admin/access-grants', '/api/admin/access-grants/missing', '/api/admin/audit-logs', '/api/events/outbox/metrics']) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: memberCookie } })).statusCode).toBe(403);
    }
    for (const [method, url, payload] of [
      ['POST', '/api/admin/access-grants', { email: 'tester@gmail.com' }],
      ['PATCH', '/api/admin/access-grants/missing/status', { status: 'DISABLED', expectedVersion: 1, reason: 'test' }],
      ['POST', `/api/admin/users/${owner.id}/revoke-sessions`, { reason: 'test' }],
    ] as const) expect((await app.inject({ method, url, payload, headers: mutation(memberCookie, memberCsrf) })).statusCode).toBe(403);
  });
  it('system role does not bypass household tenancy', async () => {
    const group = await prisma.household.findFirstOrThrow({ where: { members: { some: { userId: member.id } } } });
    const response = await app.inject({ method: 'GET', url: `/api/households/${group.id}/accounts`, headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(403);
  });
  it('rejects mass assignment and missing reason, origin or session-bound CSRF', async () => {
    const payload = { email: `mass-${suffix}@gmail.com`, systemRole: 'SYSTEM_ADMIN' };
    expect((await app.inject({ method: 'POST', url: '/api/admin/access-grants', payload, headers: mutation(ownerCookie, ownerCsrf) })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/admin/access-grants', payload: { email: 'test@gmail.com' }, headers: { cookie: ownerCookie, 'x-orfina-csrf': ownerCsrf } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/access-grants', payload: { email: 'test@gmail.com' }, headers: mutation(ownerCookie.replace(ownerCsrf, 'forged'), 'forged') })).statusCode).toBe(403);
    const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { userId: member.id } });
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/access-grants/${grant.id}/status`, payload: { status: 'DISABLED', expectedVersion: grant.version }, headers: mutation(ownerCookie, ownerCsrf) })).statusCode).toBe(422);
  });
  it('prevents self disable and last-admin demotion', async () => {
    const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { userId: owner.id } });
    await expect(admin.setStatus(actor, grant.id, { status: 'DISABLED', expectedVersion: grant.version, reason: 'test' })).rejects.toMatchObject({ status: 409 });
    await expect(operateAdmin(prisma, { action: 'demote', email: owner.email, googleSub: owner.googleId!, reason: 'test' })).rejects.toMatchObject({ status: 409 });
  });
  it('serializes concurrent administrator demotions and leaves an active administrator', async () => {
    const secondEmail = `second-${suffix}@gmail.com`; const secondSub = `99${suffix}`;
    await operateAdmin(prisma, { action: 'recover', email: secondEmail, googleSub: secondSub, reason: 'Fictional recovery' });
    const results = await Promise.allSettled([
      operateAdmin(prisma, { action: 'demote', email: owner.email, googleSub: owner.googleId!, reason: 'Concurrent role change' }),
      operateAdmin(prisma, { action: 'demote', email: secondEmail, googleSub: secondSub, reason: 'Concurrent role change' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.user.count({ where: { systemRole: 'SYSTEM_ADMIN', accessGrant: { is: { status: 'ENABLED' } } } })).toBe(1);
    await operateAdmin(prisma, { action: 'recover', email: owner.email, googleSub: owner.googleId!, reason: 'Restore fixture actor' });
    const restored = await auth.createSession(owner); actor = { id: owner.id, sessionId: restored.session.id };
    ownerCookie = `orfina_session=${restored.token}; orfina_csrf=${restored.csrf}`; ownerCsrf = restored.csrf;
  });
  it('rolls back access when audit/outbox persistence fails', async () => {
    const faulty = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction((tx) => fn(new Proxy(tx, { get(target, property) { return property === 'systemAuditLog' ? { create: () => { throw new Error('simulated audit failure'); } } : Reflect.get(target, property); } }))) };
    const service = new AdminService(faulty as never); const email = `rollback-${suffix}@gmail.com`;
    await expect(service.create(actor, { email })).rejects.toThrow();
    expect(await prisma.accessGrant.findUnique({ where: { normalizedEmail: email } })).toBeNull();
  });
  it('blocks reads, writes and refresh after disable; re-enable never revives old sessions', async () => {
    const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { userId: member.id } });
    await admin.setStatus(actor, grant.id, { status: 'DISABLED', expectedVersion: grant.version, reason: 'Beta access ended' });
    expect((await app.inject({ method: 'GET', url: '/api/households', headers: { cookie: memberCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: mutation(memberCookie, memberCsrf) })).statusCode).toBe(401);
    const updated = await prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    await expect(admin.setStatus(actor, grant.id, { status: 'ENABLED', expectedVersion: grant.version })).rejects.toMatchObject({ status: 409 });
    await admin.setStatus(actor, grant.id, { status: 'ENABLED', expectedVersion: updated.version });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: memberCookie } })).statusCode).toBe(401);
    expect((await auth.signInWithGoogle(profile(member.googleId!, member.email))).session.userId).toBe(member.id);
  });
  it('serializes refresh/disable so no usable session survives', async () => {
    const issued = await auth.createSession(member); const grant = await prisma.accessGrant.findUniqueOrThrow({ where: { userId: member.id } });
    await Promise.allSettled([auth.rotateSession(member, issued.session.id), admin.setStatus(actor, grant.id, { status: 'DISABLED', expectedVersion: grant.version, reason: 'Concurrent revoke' })]);
    expect(await prisma.session.count({ where: { userId: member.id, revokedAt: null } })).toBe(0);
  });
  it('returns generic callback rejection and clears OAuth/session cookies without invoking exchange on bad state', async () => {
    const exchange = jest.spyOn(app.get(GoogleIdentityService), 'exchange');
    const response = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=fictional&state=wrong' });
    expect(response.statusCode).toBe(302); expect(response.headers.location).toContain('/acesso-restrito');
    expect(response.headers.location).not.toContain('code'); expect(exchange).not.toHaveBeenCalled(); exchange.mockRestore();
  });
  it('lets invalid sessions clear cookies through protected-origin logout', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin } });
    expect(response.statusCode).toBe(201); expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
