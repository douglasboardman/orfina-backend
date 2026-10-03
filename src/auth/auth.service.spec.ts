import { AuthService } from './auth.service';

describe('AuthService revocable sessions', () => {
  const prisma = {
    user: { upsert: jest.fn(), findUniqueOrThrow: jest.fn() },
    session: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  };
  const jwt = { sign: jest.fn().mockReturnValue('signed-token') };
  const service = new AuthService(prisma as never, jwt as never);

  beforeEach(() => jest.clearAllMocks());

  it('creates a persisted session and embeds only its id in the signed token', async () => {
    prisma.session.create.mockResolvedValue({ id: 'session_1', userId: 'user_1', expiresAt: new Date('2026-10-10') });

    const result = await service.createSession({ id: 'user_1', email: 'person@example.test', name: 'Person' } as never);

    expect(result.token).toBe('signed-token');
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user_1', sid: 'session_1' }));
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user_1' }) }));
  });

  it('accepts only a non-revoked and non-expired persisted session', async () => {
    prisma.session.findFirst.mockResolvedValueOnce({ id: 'session_1' }).mockResolvedValueOnce(null);

    await expect(service.isSessionActive('session_1', 'user_1')).resolves.toBe(true);
    await expect(service.isSessionActive('session_1', 'user_1')).resolves.toBe(false);
    expect(prisma.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'session_1', userId: 'user_1', revokedAt: null, expiresAt: { gt: expect.any(Date) } }),
    }));
  });

  it('revokes the old session before rotation', async () => {
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.create.mockResolvedValue({ id: 'session_2', userId: 'user_1', expiresAt: new Date('2026-10-10') });

    await service.rotateSession({ id: 'user_1', email: 'person@example.test', name: 'Person' } as never, 'session_1');

    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'session_1', userId: 'user_1', revokedAt: null } }));
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sid: 'session_2' }));
  });
});
