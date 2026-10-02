import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
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

  createAccessToken(user: User) {
    return this.jwt.sign({ sub: user.id, email: user.email, name: user.name });
  }
}
