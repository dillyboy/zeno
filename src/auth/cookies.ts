import type { FastifyReply } from 'fastify';

export const accessCookieName = 'access_token';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setAccessCookie(reply: FastifyReply, token: string) {
  reply.setCookie(accessCookieName, token, { ...cookieOptions(), maxAge: 3600 });
}

export function clearAccessCookie(reply: FastifyReply) {
  reply.clearCookie(accessCookieName, cookieOptions());
}
