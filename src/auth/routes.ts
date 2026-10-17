import { compare } from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from './user.ts';
import { createSession, deactivateSession, rotateSession } from './session.ts';
import { hashRefreshToken, issueTokens, type TokenClaims } from './tokens.ts';
import { accessCookieName, clearAccessCookie, setAccessCookie } from './cookies.ts';

// A valid hash keeps password comparison work similar for unknown users.
const dummyHash = '$2b$12$UREFwsRUoyF0CRqGNK0LzO0HM/jLhgUCNNIJ9RJAqMUQ74crlJ1Vu';

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log in with email and password',
        description:
          'Verifies credentials and creates or reactivates the user session, replacing its previous token. The JWT expires after one hour.',
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
            required: ['user', 'token', 'refreshToken'],
            properties: {
              token: { type: 'string' },
              refreshToken: { type: 'string' },
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
      reply.header('Cache-Control', 'no-store');
      return {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        user: { id: user._id.toString(), name: user.name, email: user.email },
      };
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    '/auth/refresh',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Refresh access and refresh tokens',
        description:
          'Exchanges the current refresh token for a new pair. Each refresh token can be used only once. No access token is required.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['token', 'refreshToken'],
            properties: { token: { type: 'string' }, refreshToken: { type: 'string' } },
          },
          401: { type: 'object', properties: { message: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      let claims: TokenClaims;
      try {
        claims = app.jwt.verify<TokenClaims>(request.body.refreshToken);
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
        hashRefreshToken(request.body.refreshToken),
        tokens,
      );
      if (!rotated) {
        return reply.code(401).send({ message: 'Invalid or expired refresh token' });
      }
      setAccessCookie(reply, tokens.token);
      reply.header('Cache-Control', 'no-store');
      return { token: tokens.token, refreshToken: tokens.refreshToken };
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
          return reply.code(401).send({ message: 'Invalid or expired session' });
        }
        email = claims.email;
        token = (match?.[1] ?? request.cookies[accessCookieName])!;
      } catch {
        return reply.code(401).send({ message: 'Invalid or expired session' });
      }
      const deactivated = await deactivateSession(app.db, email, token);
      if (!deactivated) {
        return reply.code(401).send({ message: 'Invalid or expired session' });
      }
      clearAccessCookie(reply);
      return { message: 'Logged out successfully' };
    },
  );
}
