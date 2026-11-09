import { injectAuth } from './testRequest.ts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { buildApp } from '../app.ts';
import { rotateSession, deactivateSession, deactivateRefreshSession } from './session.ts';
import { hashRefreshToken, issueTokens } from './tokens.ts';

vi.mock('./session.ts', () => ({
  createSession: vi.fn(),
  deactivateSession: vi.fn(),
  deactivateRefreshSession: vi.fn(),
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
      headers: { cookie: `refresh_token=${original.refreshToken}` },
    };
    const response = await injectAuth(app, request);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.token).not.toBe(original.token);
    expect(body).not.toHaveProperty('refreshToken');
    const cookies = response.cookies;
    const refreshCookie = cookies.find((cookie) => cookie.name === 'refresh_token')!;
    expect(refreshCookie.value).not.toBe(original.refreshToken);
    expect(refreshCookie.httpOnly).toBe(true);
    expect(refreshCookie.sameSite).toBe('Strict');
    expect(cookies.find((cookie) => cookie.name === 'access_token')?.value).toBe(body.token);
    expect(body.accessExpiresAt).toBeGreaterThan(Date.now());
    expect(app.jwt.verify(body.token)).toMatchObject({ token_use: 'access' });
    expect(app.jwt.verify(refreshCookie.value)).toMatchObject({ token_use: 'refresh' });
    expect(rotateSession).toHaveBeenCalledWith(
      undefined,
      'test@example.com',
      hashRefreshToken(original.refreshToken),
      expect.objectContaining({
        token: body.token,
        refreshTokenHash: hashRefreshToken(refreshCookie.value),
      }),
    );
    expect((await injectAuth(app, request)).statusCode).toBe(401);
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
        (await injectAuth(app, { method: 'POST', url: '/auth/refresh', payload: { refreshToken } }))
          .statusCode,
      ).toBe(401);
    }
    expect(rotateSession).not.toHaveBeenCalled();
    const logout = await injectAuth(app, {
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
    const response = await injectAuth(app, {
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
      (await injectAuth(app, { method: 'POST', url: '/auth/refresh', payload: {} })).statusCode,
    ).toBe(401);
    expect(rotateSession).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('logs out using the refresh cookie after the access cookie expires and clears both cookies', async () => {
  const app = await buildApp();
  try {
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    vi.mocked(deactivateRefreshSession).mockResolvedValue(true);
    const response = await injectAuth(app, {
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `refresh_token=${pair.refreshToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(deactivateRefreshSession).toHaveBeenCalledWith(
      undefined,
      'test@example.com',
      hashRefreshToken(pair.refreshToken),
    );
    expect(response.cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([
      ['access_token', ''],
      ['refresh_token', ''],
    ]);
  } finally {
    await app.close();
  }
});

it('sets Secure cookies in production', async () => {
  vi.stubEnv('CSRF_ALLOWED_ORIGINS', 'http://localhost:5173');
  vi.stubEnv('NODE_ENV', 'production');
  const app = await buildApp();
  try {
    vi.mocked(rotateSession).mockResolvedValue(true);
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    const response = await injectAuth(app, {
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `refresh_token=${pair.refreshToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies).toHaveLength(2);
    expect(response.cookies.every((cookie) => cookie.secure && cookie.httpOnly)).toBe(true);
  } finally {
    await app.close();
    vi.stubEnv('NODE_ENV', 'test');
  }
});
