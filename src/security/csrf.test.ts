import { afterEach, expect, it, vi } from 'vite-plus/test';
import { buildApp } from '../app.ts';
import {
  createSession,
  rotateSession,
  deactivateSession,
  deactivateRefreshSession,
} from '../auth/session.ts';
import { findUserByEmail } from '../auth/user.ts';
import { allowedBrowserOrigins } from './csrf.ts';
vi.mock('../auth/session.ts', () => ({
  createSession: vi.fn(),
  rotateSession: vi.fn(),
  deactivateSession: vi.fn(),
  deactivateRefreshSession: vi.fn(),
}));
vi.mock('../auth/user.ts', () => ({ findUserByEmail: vi.fn() }));
const secret = 'test-only-secret-at-least-32-bytes-long';
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it('rejects untrusted, null, malformed and missing origins before auth work or cookie changes', async () => {
  const app = await buildApp({}, secret);
  try {
    const token = app.jwt.sign({ sub: 'id', email: 'test@example.com', token_use: 'refresh' });
    for (const url of ['/auth/login', '/auth/refresh', '/auth/logout']) {
      for (const origin of [
        undefined,
        'null',
        'https://attacker.example',
        'http://localhost:5173.attacker.example',
        'http://localhost:5173/path',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          payload: {},
          headers: {
            ...(origin === undefined ? {} : { origin }),
            cookie: `refresh_token=${token}`,
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    for (const operation of [
      findUserByEmail,
      createSession,
      rotateSession,
      deactivateSession,
      deactivateRefreshSession,
    ])
      expect(operation).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('requires JSON on authentication and future mutation routes and protects origin fallback', async () => {
  const app = await buildApp({}, secret);
  const mutation = vi.fn(async () => ({ ok: true }));
  app.patch('/test-mutation', mutation);
  try {
    for (const url of ['/auth/login', '/auth/refresh', '/auth/logout']) {
      for (const type of [
        undefined,
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'http://localhost:5173', ...(type ? { 'content-type': type } : {}) },
          ...(type ? { payload: '{}' } : {}),
        });
        expect(response.statusCode).toBe(415);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: { referer: 'http://localhost:5173/login' },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: { origin: 'null', referer: 'http://localhost:5173/login' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: {
            origin: 'http://localhost:5173',
            'content-type': 'application/json; charset=utf-8',
          },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'PATCH', url: '/test-mutation', payload: {} })).statusCode,
    ).toBe(403);
    expect(mutation).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/test-mutation',
          headers: { origin: 'http://localhost:5173' },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await app.close();
  }
});

it('allows originless read-only POSTs but rejects an explicit untrusted source', async () => {
  const app = await buildApp({}, secret);
  app.post('/read-only', { config: { csrfReadOnly: true } }, async () => ({ ok: true }));
  try {
    expect((await app.inject({ method: 'POST', url: '/read-only', payload: {} })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/read-only',
          headers: { origin: 'https://attacker.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

it('requires explicit exact allowed origins in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CSRF_ALLOWED_ORIGINS', '');
  expect(allowedBrowserOrigins).toThrow('required in production');
  for (const value of ['*', 'https://app.example/', 'null', 'https://app.example/path']) {
    vi.stubEnv('CSRF_ALLOWED_ORIGINS', value);
    expect(allowedBrowserOrigins).toThrow('exact HTTP(S) origins');
  }
  vi.stubEnv('CSRF_ALLOWED_ORIGINS', 'https://app.example');
  expect(allowedBrowserOrigins()).toEqual(new Set(['https://app.example']));
});
