import { afterEach, expect, it, vi } from 'vite-plus/test';
import { hashSync } from 'bcryptjs';
import { Types } from 'mongoose';
import { buildApp } from '../app.ts';
import { findUserByEmail } from './user.ts';
import { createSession, deactivateSession } from './session.ts';

vi.mock('./user.ts', () => ({ findUserByEmail: vi.fn() }));
vi.mock('./session.ts', () => ({
  createSession: vi.fn(),
  deactivateSession: vi.fn(),
  rotateSession: vi.fn(),
}));
vi.stubEnv('JWT_SECRET', 'test-only-secret-at-least-32-bytes-long');
afterEach(() => vi.resetAllMocks());

const user = {
  __v: 0,
  _id: new Types.ObjectId(),
  name: 'Test User',
  email: 'test@example.com',
  password: hashSync('test-password', 4),
};

it('marks only the supplied active session inactive on logout', async () => {
  vi.mocked(deactivateSession).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const app = await buildApp();
  try {
    const token = app.jwt.sign({
      sub: user._id.toString(),
      email: user.email,
      token_use: 'access',
    });
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'Logged out successfully' });
    expect(deactivateSession).toHaveBeenCalledWith(undefined, user.email, token);
    const again = await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect(again.statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

it('rejects missing, tampered, and expired logout tokens', async () => {
  const app = await buildApp();
  try {
    const expired = app.jwt.sign({ email: user.email, iat: 1 }, { expiresIn: 1 });
    for (const authorization of ['', 'Bearer invalid-token', `Bearer ${expired}`]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(deactivateSession).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('does not return a token if persisting the session fails', async () => {
  vi.mocked(findUserByEmail).mockResolvedValue(user);
  vi.mocked(createSession).mockRejectedValue(new Error('Database unavailable'));
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: user.email, password: 'test-password' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty('token');
  } finally {
    await app.close();
  }
});

it('verifies bcrypt credentials and excludes the password from the response', async () => {
  vi.mocked(findUserByEmail).mockResolvedValue(user);
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: user.email, password: 'test-password' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      token: expect.any(String),
      refreshToken: expect.any(String),
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
      },
    });
    expect(createSession).toHaveBeenCalledWith(
      undefined,
      user.email,
      expect.objectContaining({ token: body.token, refreshTokenHash: expect.any(String) }),
    );
    const claims = app.jwt.verify<{ sub: string; email: string; exp: number; iat: number }>(
      body.token,
    );
    expect(claims.sub).toBe(user._id.toString());
    expect(claims.email).toBe(user.email);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims).not.toHaveProperty('password');
  } finally {
    await app.close();
  }
});

it.each([null, user])(
  'returns the same rejection for unknown users and wrong passwords',
  async (result) => {
    vi.mocked(findUserByEmail).mockResolvedValue(result);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: 'wrong-password' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ message: 'Invalid email or password' });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it.each([
  { email: user.email },
  { email: { $ne: null }, password: 'test-password' },
  { email: 'invalid', password: 'test-password' },
])('rejects invalid login input before querying the database', async (payload) => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload });
    expect(response.statusCode).toBe(400);
    expect(findUserByEmail).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
