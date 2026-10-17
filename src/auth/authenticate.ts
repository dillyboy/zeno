import type { FastifyReply, FastifyRequest } from 'fastify';
import { accessCookieName } from './cookies.ts';
import { hasActiveSession } from './session.ts';
import type { TokenClaims } from './tokens.ts';

export async function authenticateCookie(request: FastifyRequest, reply: FastifyReply) {
  let claims: TokenClaims;
  try {
    claims = await request.jwtVerify<TokenClaims>({ onlyCookie: true });
    if (
      claims.token_use !== 'access' ||
      typeof claims.email !== 'string' ||
      typeof claims.sub !== 'string'
    ) {
      return reply.code(401).send({ message: 'Invalid or expired session' });
    }
  } catch {
    return reply.code(401).send({ message: 'Invalid or expired session' });
  }
  const token = request.cookies[accessCookieName];
  if (!token || !(await hasActiveSession(request.server.db, claims.email, token))) {
    return reply.code(401).send({ message: 'Invalid or expired session' });
  }
}
