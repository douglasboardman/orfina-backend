import { AuthService, hashCsrf } from './auth.service';

describe('AuthService access gate', () => {
  const tx = {
    $executeRaw: jest.fn(), accessGrant: { findUnique: jest.fn() },
    session: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn: (value: typeof tx) => unknown) => fn(tx)) };
  const jwt = { sign: jest.fn().mockReturnValue('signed-token'), verify: jest.fn() };
  const service = new AuthService(prisma as never, jwt as never);
  beforeEach(() => { jest.clearAllMocks(); tx.accessGrant.findUnique.mockResolvedValue({ status: 'ENABLED' }); });
  it('creates a session-bound proof and keeps profile/role out of JWT', async () => {
    tx.session.create.mockResolvedValue({ id: 'session_1' });
    const result = await service.createSession({ id: 'user_1' } as never);
    expect(result.csrf).toHaveLength(64);
    expect(tx.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ csrfTokenHash: hashCsrf(result.csrf) }) }));
    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'user_1', sid: 'session_1' });
  });
  it('refuses disabled access before issuing a session', async () => {
    tx.accessGrant.findUnique.mockResolvedValue({ status: 'DISABLED' });
    await expect(service.createSession({ id: 'user_1' } as never)).rejects.toMatchObject({ status: 403 });
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it('denies missing grants and propagates database failures without granting access', async () => {
    tx.accessGrant.findUnique.mockResolvedValue(null);
    await expect(service.createSession({ id: 'user_1' } as never)).rejects.toMatchObject({ status: 403 });
    tx.session.findFirst.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.isSessionActive('sid', 'uid')).rejects.toThrow('database unavailable');
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it('requires a live grant for every session lookup', async () => {
    tx.session.findFirst.mockResolvedValue(null);
    await expect(service.isSessionActive('session_1', 'user_1')).resolves.toBe(false);
    expect(tx.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      user: { accessGrant: { is: { status: 'ENABLED' } } }, revokedAt: null,
    }) }));
  });
  it('rejects reuse of a revoked rotation and never issues its replacement', async () => {
    tx.session.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.rotateSession({ id: 'user_1' } as never, 'old')).rejects.toMatchObject({ status: 401 });
    expect(tx.session.create).not.toHaveBeenCalled();
  });
});
