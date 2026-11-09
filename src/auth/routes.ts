import { createLoginThrottle } from './loginThrottle.ts';
import { compare } from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from './user.ts';
import {
  createSession,
  deactivateSession,
  deactivateRefreshSession,
  rotateSession,
} from './session.ts';
import { hashRefreshToken, issueTokens, type TokenClaims } from './tokens.ts';
import {
  accessCookieName,
  refreshCookieName,
  clearAuthCookies,
  setAccessCookie,
  setRefreshCookie,
} from './cookies.ts';

// A valid hash keeps password comparison work similar for unknown users.
const dummyHash = '$2b$12$UREFwsRUoyF0CRqGNK0LzO0HM/jLhgUCNNIJ9RJAqMUQ74crlJ1Vu';

export function registerAuthRoutes(app: FastifyInstance) {
  const loginThrottle = createLoginThrottle();
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      onRequest: loginThrottle.onRequest,
      preHandler: loginThrottle.preHandler,
      schema: {
        tags: ['Auth'],
        summary: 'Log in with email and password',
        description:
          'Verifies credentials and creates or reactivates the user session, replacing its previous token. The JWT expires after 15 minutes.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 72, format: 'password' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['user', 'token', 'accessExpiresAt'],
            properties: {
              token: { type: 'string' },
              accessExpiresAt: { type: 'number' },
              user: {
                type: 'object',
                required: ['id', 'name', 'email'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
          },
          429: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
          401: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      if (Buffer.byteLength(password, 'utf8') > 72) {
        return reply.code(400).send({ message: 'Password must be at most 72 bytes.' });
      }
      const user = await findUserByEmail(app.db, email.trim());
      const matches = await compare(password, user?.password ?? dummyHash);
      if (!user || !matches) {
        return reply.code(401).send({ message: 'Invalid email or password' });
      }
      const tokens = issueTokens(app, user._id.toString(), user.email);
      await createSession(app.db, user.email, tokens);
      setAccessCookie(reply, tokens.token);
      setRefreshCookie(reply, tokens.refreshToken);
      reply.header('Cache-Control', 'no-store');
      return {
        token: tokens.token,
        accessExpiresAt: app.jwt.decode<TokenClaims>(tokens.token)!.exp * 1000,
        user: { id: user._id.toString(), name: user.name, email: user.email },
      };
    },
  );

  app.post<{ Body: { refreshToken?: string } | undefined }>(
    '/auth/refresh',
    {
      preValidation: async (request) => {
        request.body ??= {};
      },
      schema: {
        tags: ['Auth'],
        summary: 'Refresh access and refresh tokens',
        description:
          'Rotates the HttpOnly refresh cookie and access cookie. Each refresh token is single-use. No access token is required. Returns access expiry metadata; refresh tokens are never returned in JSON.',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['token', 'accessExpiresAt'],
            properties: { token: { type: 'string' }, accessExpiresAt: { type: 'number' } },
          },
          401: { type: 'object', properties: { message: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const refreshToken = request.cookies[refreshCookieName] ?? request.body?.refreshToken;
      if (!refreshToken) {
        return reply.code(401).send({ message: 'Missing refresh token' });
      }
      let claims: TokenClaims;
      try {
        claims = app.jwt.verify<TokenClaims>(refreshToken);
        if (
          claims.token_use !== 'refresh' ||
          typeof claims.sub !== 'string' ||
          typeof claims.email !== 'string'
        ) {
          return reply.code(401).send({ message: 'Invalid or expired refresh token' });
        }
      } catch {
        return reply.code(401).send({ message: 'Invalid or expired refresh token' });
      }
      const tokens = issueTokens(app, claims.sub, claims.email);
      const rotated = await rotateSession(
        app.db,
        claims.email,
        hashRefreshToken(refreshToken),
        tokens,
      );
      if (!rotated) {
        return reply.code(401).send({ message: 'Invalid or expired refresh token' });
      }
      setAccessCookie(reply, tokens.token);
      setRefreshCookie(reply, tokens.refreshToken);
      reply.header('Cache-Control', 'no-store');
      return {
        token: tokens.token,
        accessExpiresAt: app.jwt.decode<TokenClaims>(tokens.token)!.exp * 1000,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log out the current session',
        description:
          'Revokes only the supplied current Bearer token. The user is identified from the verified token; other users remain logged in.',
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        response: {
          200: { type: 'object', properties: { message: { type: 'string' } } },
          401: { type: 'object', properties: { message: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const refreshToken = request.cookies[refreshCookieName];
      if (refreshToken) {
        let claims: TokenClaims;
        try {
          claims = app.jwt.verify<TokenClaims>(refreshToken);
        } catch {
          clearAuthCookies(reply);
          return reply.code(401).send({ message: 'Invalid or expired session' });
        }
        if (
          claims.token_use !== 'refresh' ||
          typeof claims.email !== 'string' ||
          typeof claims.sub !== 'string'
        ) {
          clearAuthCookies(reply);
          return reply.code(401).send({ message: 'Invalid or expired session' });
        }
        await deactivateRefreshSession(app.db, claims.email, hashRefreshToken(refreshToken));
        clearAuthCookies(reply);
        return { message: 'Logged out successfully' };
      }
      let email: string;
      let token: string;
      try {
        const claims = await request.jwtVerify<TokenClaims>();
        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        if (
          !(match?.[1] ?? request.cookies[accessCookieName]) ||
          typeof claims.email !== 'string' ||
          typeof claims.sub !== 'string' ||
          claims.token_use !== 'access'
        ) {
          clearAuthCookies(reply);
          return reply.code(401).send({ message: 'Invalid or expired session' });
        }
        email = claims.email;
        token = (match?.[1] ?? request.cookies[accessCookieName])!;
      } catch {
        clearAuthCookies(reply);
        return reply.code(401).send({ message: 'Invalid or expired session' });
      }
      const deactivated = await deactivateSession(app.db, email, token);
      clearAuthCookies(reply);
      if (!deactivated) {
        return reply.code(401).send({ message: 'Invalid or expired session' });
      }
      return { message: 'Logged out successfully' };
    },
  );
}
