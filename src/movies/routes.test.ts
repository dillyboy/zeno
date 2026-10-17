import { afterEach, expect, it, vi } from 'vite-plus/test';
import { hashSync } from 'bcryptjs';
import { Types } from 'mongoose';
import { buildApp } from '../app.ts';
import { findUserByEmail } from '../auth/user.ts';
import {
  createSession,
  deactivateSession,
  hasActiveSession,
  rotateSession,
} from '../auth/session.ts';
import { findTopMovies } from './movie.ts';
import { issueTokens } from '../auth/tokens.ts';

vi.mock('../auth/user.ts', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../auth/session.ts', () => ({
  createSession: vi.fn(),
  deactivateSession: vi.fn(),
  hasActiveSession: vi.fn(),
  rotateSession: vi.fn(),
}));
vi.mock('./movie.ts', () => ({ findTopMovies: vi.fn() }));
vi.stubEnv('JWT_SECRET', 'test-only-secret-at-least-32-bytes-long');
afterEach(() => vi.resetAllMocks());

it('sets a login cookie, serves movies, and clears the cookie on logout', async () => {
  const app = await buildApp();
  try {
    const id = new Types.ObjectId();
    vi.mocked(findUserByEmail).mockResolvedValue({
      _id: id,
      __v: 0,
      name: 'Test',
      email: 'test@example.com',
      password: hashSync('test-password', 4),
    });
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(hasActiveSession).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(deactivateSession).mockResolvedValue(true);
    vi.mocked(findTopMovies).mockResolvedValue([
      { _id: id, __v: 0, title: 'Movie', year: '2001–2002', imdb: { rating: 9 } },
    ]);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const cookie = setCookie.split(';')[0]!;
    const response = await app.inject({ method: 'GET', url: '/movies/top', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().movies[0].title).toBe('Movie');
    expect(response.json().movies[0].year).toBe('2001–2002');
    expect(hasActiveSession).toHaveBeenCalledWith(
      undefined,
      'test@example.com',
      login.json().token,
    );
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Expires=Thu, 01 Jan 1970');
    expect(
      (await app.inject({ method: 'GET', url: '/movies/top', headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(findTopMovies).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('rejects missing, expired, invalid, refresh, and header-only tokens', async () => {
  const app = await buildApp();
  try {
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    const expired = app.jwt.sign(
      { sub: 'user-id', email: 'test@example.com', token_use: 'access', iat: 1 },
      { expiresIn: 1 },
    );
    for (const token of ['', 'invalid', pair.refreshToken, expired]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/movies/top',
            headers: { cookie: `access_token=${token}` },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/movies/top',
          headers: { authorization: `Bearer ${pair.token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(hasActiveSession).not.toHaveBeenCalled();
    expect(findTopMovies).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('refresh replaces the browser access cookie', async () => {
  const app = await buildApp();
  try {
    vi.mocked(rotateSession).mockResolvedValue(true);
    const pair = issueTokens(app, 'user-id', 'test@example.com');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: pair.refreshToken },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain(
      `access_token=${response.json().token}`,
    );
  } finally {
    await app.close();
  }
});
