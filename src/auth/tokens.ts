import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface TokenClaims {
  sub: string;
  email: string;
  token_use: 'access' | 'refresh';
  exp: number;
}

export function hashRefreshToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function issueTokens(app: FastifyInstance, id: string, email: string) {
  const token = app.jwt.sign({ sub: id, email, token_use: 'access', jti: randomUUID() });
  const refreshToken = app.jwt.sign(
    { sub: id, email, token_use: 'refresh', jti: randomUUID() },
    { expiresIn: '7d' },
  );
  const { exp } = app.jwt.decode<TokenClaims>(refreshToken)!;
  return {
    token,
    refreshToken,
    refreshTokenHash: hashRefreshToken(refreshToken),
    refreshExpiresAt: new Date(exp * 1000),
  };
}
