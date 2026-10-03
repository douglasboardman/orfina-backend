import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Session, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type GoogleProfile = { googleId: string; email: string; name: string; avatarUrl?: string };

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async signInWithGoogle(profile: GoogleProfile): Promise<User> {
    return this.prisma.user.upsert({
      where: { email: profile.email },
      create: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl, googleId: profile.googleId },
      update: { name: profile.name, avatarUrl: profile.avatarUrl, googleId: profile.googleId },
    });
  }

  async findUser(userId: string): Promise<User> {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  }

  async createSession(user: User): Promise<{ session: Session; token: string }> {
    const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? 7);
    const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
    const session = await this.prisma.session.create({ data: { userId: user.id, expiresAt } });
    return { session, token: this.createAccessToken(user, session.id) };
  }

  async rotateSession(user: User, sessionId: string): Promise<{ session: Session; token: string }> {
    await this.revokeSession(sessionId, user.id);
    return this.createSession(user);
  }

  async revokeSession(sessionId: string, userId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async isSessionActive(sessionId: string, userId: string) {
    return Boolean(await this.prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    }));
  }

  private createAccessToken(user: User, sessionId: string) {
    return this.jwt.sign({ sub: user.id, sid: sessionId, email: user.email, name: user.name });
  }
}
