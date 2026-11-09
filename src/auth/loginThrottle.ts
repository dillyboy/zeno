import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const loginWindowMs = 15 * 60 * 1000;
export const loginIpLimit = 20;
export const loginAccountLimit = 5;
const maxBuckets = 10_000;

/** Fixed windows; full storage fails closed instead of evicting active limits. */
export function createAttemptLimiter(limit: number, capacity = maxBuckets) {
  const buckets = new Map<string, { attempts: number; expiresAt: number }>();
  return (key: string, now = Date.now()): number => {
    let bucket = buckets.get(key);
    if (bucket && bucket.expiresAt <= now) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (buckets.size >= capacity) {
        for (const [storedKey, stored] of buckets) {
          if (stored.expiresAt <= now) buckets.delete(storedKey);
        }
        if (buckets.size >= capacity) return loginWindowMs;
      }
      bucket = { attempts: 0, expiresAt: now + loginWindowMs };
      buckets.set(key, bucket);
    }
    if (bucket.attempts >= limit) return bucket.expiresAt - now;
    bucket.attempts += 1;
    return 0;
  };
}

function reject(reply: FastifyReply, retryMs: number) {
  return reply
    .header('Cache-Control', 'no-store')
    .header('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))))
    .code(429)
    .send({ message: 'Too many sign-in attempts. Please try again later.' });
}

/** Per-app counters reserve attempts synchronously, before asynchronous password work. */
export function createLoginThrottle() {
  const ipAttempts = createAttemptLimiter(loginIpLimit);
  const accountAttempts = createAttemptLimiter(loginAccountLimit);
  return {
    async onRequest(this: void, request: FastifyRequest, reply: FastifyReply) {
      // Fastify ignores forwarded IP headers unless trustProxy is explicitly enabled.
      const retryMs = ipAttempts(request.ip);
      if (retryMs) return reject(reply, retryMs);
    },
    async preHandler(
      this: void,
      request: FastifyRequest<{ Body: { email: string; password: string } }>,
      reply: FastifyReply,
    ) {
      // Hash normalized identifiers so the limiter retains no plaintext email addresses.
      const key = createHash('sha256')
        .update(request.body.email.trim().toLowerCase())
        .digest('hex');
      const retryMs = accountAttempts(key);
      if (retryMs) return reject(reply, retryMs);
    },
  };
}
