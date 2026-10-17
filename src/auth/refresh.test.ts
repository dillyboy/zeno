import { afterEach, expect, it, vi } from 'vite-plus/test';
import { buildApp } from '../app.ts';
import { rotateSession, deactivateSession } from './session.ts';
import { hashRefreshToken, issueTokens } from './tokens.ts';

vi.mock('./session.ts', () => ({
  createSession: vi.fn(),
  deactivateSession: vi.fn(),
  rotateSession: vi.fn(),
}));
vi.stubEnv('JWT_SECRET', 'test-only-secret-at-least-32-bytes-long');
afterEach(() => vi.resetAllMocks());

it('rotates both tokens without requiring a valid access token and rejects refresh reuse', async () => {
  const app = await buildApp();
  try {
    const original = issueTokens(app, '59b99db4cfa9a34dcd7885b6', 'test@example.com');
    vi.mocked(rotateSession).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = {
      method: 'POST' as const,
      url: '/auth/refresh',
      payload: { refreshToken: original.refreshToken },
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.token).not.toBe(original.token);
    expect(body.refreshToken).not.toBe(original.refreshToken);
    expect(app.jwt.verify(body.token)).toMatchObject({ token_use: 'access' });
    expect(app.jwt.verify(body.refreshToken)).toMatchObject({ token_use: 'refresh' });
    expect(rotateSession).toHaveBeenCalledWith(
      undefined,
      'test@example.com',
      hashRefreshToken(original.refreshToken),
      expect.objectContaining({
        token: body.token,
        refreshTokenHash: hashRefreshToken(body.refreshToken),
      }),
    );
    expect((await app.inject(request)).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

it('rejects invalid, expired, and access tokens before updating the session', async () => {
  const app = await buildApp();
  try {
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    const expired = app.jwt.sign(
      { sub: 'user-id', email: 'test@example.com', token_use: 'refresh', iat: 1 },
      { expiresIn: 1 },
    );
    for (const refreshToken of ['invalid', expired, pair.token]) {
      expect(
        (await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } }))
          .statusCode,
      ).toBe(401);
    }
    expect(rotateSession).not.toHaveBeenCalled();
    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${pair.refreshToken}` },
    });
    expect(logout.statusCode).toBe(401);
    expect(deactivateSession).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('rejects inactive or replaced sessions without returning tokens', async () => {
  const app = await buildApp();
  try {
    vi.mocked(rotateSession).mockResolvedValue(false);
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: pair.refreshToken },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty('token');
  } finally {
    await app.close();
  }
});

it('requires a refresh token', async () => {
  const app = await buildApp();
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} })).statusCode,
    ).toBe(400);
    expect(rotateSession).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
