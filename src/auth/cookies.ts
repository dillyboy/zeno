import { accessTokenLifetimeSeconds, refreshTokenLifetimeSeconds } from '../config/durations.ts';
import type { FastifyReply } from 'fastify';

export const accessCookieName = 'access_token';
export const refreshCookieName = 'refresh_token';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setAccessCookie(reply: FastifyReply, token: string) {
  reply.setCookie(accessCookieName, token, {
    ...cookieOptions(),
    maxAge: accessTokenLifetimeSeconds,
  });
}

export function clearAccessCookie(reply: FastifyReply) {
  reply.clearCookie(accessCookieName, cookieOptions());
}

export function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(refreshCookieName, token, {
    ...cookieOptions(),
    maxAge: refreshTokenLifetimeSeconds,
  });
}

export function clearAuthCookies(reply: FastifyReply) {
  clearAccessCookie(reply);
  reply.clearCookie(refreshCookieName, cookieOptions());
  reply.header('Cache-Control', 'no-store');
}
