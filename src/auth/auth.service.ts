import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { identityError, lockIdentity, normalizeEmail, recordIdentity } from '../identity/identity-policy';

export type GoogleProfile = { googleId: string; email: string; emailVerified: boolean; hostedDomain?: string; name: string; avatarUrl?: string };
export const hashCsrf = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async signInWithGoogle(profile: GoogleProfile) {
    if (!profile.emailVerified) identityError(403, 'ACCESS_DENIED', 'Acesso restrito.');
    return this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      const normalizedEmail = normalizeEmail(profile.email);
      let user = await tx.user.findUnique({ where: { googleId: profile.googleId } });
      if (user) {
        await this.assertEnabled(tx, user.id);
        const collision = await tx.user.findFirst({ where: { email: { equals: profile.email, mode: 'insensitive' }, id: { not: user.id } } });
        user = await tx.user.update({ where: { id: user.id }, data: {
          name: profile.name, avatarUrl: profile.avatarUrl, lastLoginAt: new Date(),
          ...(!collision ? { email: profile.email } : {}),
        } });
      } else {
        if (!normalizedEmail.endsWith('@gmail.com') && !profile.hostedDomain) identityError(403, 'ACCESS_DENIED', 'Acesso restrito.');
        const grant = await tx.accessGrant.findUnique({ where: { normalizedEmail } });
        if (!grant || grant.status !== 'ENABLED' || grant.userId) identityError(403, 'ACCESS_DENIED', 'Acesso restrito.');
        const legacy = await tx.user.findFirst({ where: { email: { equals: profile.email, mode: 'insensitive' } } });
        if (legacy) identityError(403, 'ACCESS_DENIED', 'Acesso restrito.');
        user = await tx.user.create({ data: { email: profile.email, googleId: profile.googleId, name: profile.name,
          avatarUrl: profile.avatarUrl, lastLoginAt: new Date() } });
        await tx.accessGrant.update({ where: { id: grant.id }, data: { userId: user.id, version: { increment: 1 } } });
        await recordIdentity(tx, { actorUserId: user.id, action: 'ACCESS_LINKED', targetId: grant.id, userId: user.id,
          changes: { linked: { before: false, after: true } }, event: 'access-linked' });
      }
      return this.issue(tx, user);
    });
  }

  async findUser(userId: string): Promise<User> { return this.prisma.user.findUniqueOrThrow({ where: { id: userId } }); }

  private async assertEnabled(tx: Prisma.TransactionClient, userId: string) {
    const grant = await tx.accessGrant.findUnique({ where: { userId } });
    if (!grant || grant.status !== 'ENABLED') identityError(403, 'ACCESS_DENIED', 'Acesso restrito.');
  }

  private async issue(tx: Prisma.TransactionClient, user: User) {
    await this.assertEnabled(tx, user.id);
    const csrf = randomBytes(32).toString('hex');
    const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? 7);
    const expiresAt = new Date(Date.now() + ttlDays * 86400000);
    const session = await tx.session.create({ data: { userId: user.id, expiresAt, csrfTokenHash: hashCsrf(csrf) } });
    return { session, csrf, token: this.jwt.sign({ sub: user.id, sid: session.id }) };
  }

  async createSession(user: User) {
    return this.prisma.$transaction(async (tx) => { await lockIdentity(tx); return this.issue(tx, user); });
  }

  async rotateSession(user: User, sessionId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      await this.assertEnabled(tx, user.id);
      const revoked = await tx.session.updateMany({ where: { id: sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
      if (!revoked.count) identityError(401, 'SESSION_INVALID', 'Sessão inválida.');
      return this.issue(tx, user);
    });
  }

  async revokeSession(sessionId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      await tx.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }

  async activeSession(sessionId: string, userId: string) {
    return this.prisma.session.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() },
      user: { accessGrant: { is: { status: 'ENABLED' } } } }, include: { user: true } });
  }
  async isSessionActive(sessionId: string, userId: string) { return Boolean(await this.activeSession(sessionId, userId)); }
  async sessionFromToken(token?: string) {
    if (!token) return null;
    let payload: { sub?: string; sid?: string };
    try { payload = this.jwt.verify(token, { algorithms: ['HS256'] }); } catch { return null; }
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return this.activeSession(payload.sid, payload.sub);
  }
}
