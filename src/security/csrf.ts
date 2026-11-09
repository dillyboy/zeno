import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Only for POST endpoints that never mutate application data or credentials. */
    csrfReadOnly?: boolean;
  }
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.origin;
  } catch {
    return;
  }
}

export function allowedBrowserOrigins() {
  const configured = process.env.CSRF_ALLOWED_ORIGINS;
  if (!configured?.trim() && process.env.NODE_ENV === 'production') {
    throw new Error('CSRF_ALLOWED_ORIGINS is required in production.');
  }
  const values = (
    configured ??
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:6006,http://127.0.0.1:6006'
  )
    .split(',')
    .map((value) => value.trim());
  if (values.some((value) => !value || originOf(value) !== value)) {
    throw new Error(
      'CSRF_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or wildcards.',
    );
  }
  return new Set(values);
}

export function registerCsrfProtection(app: FastifyInstance) {
  const allowed = allowedBrowserOrigins();
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const readOnly = request.method === 'POST' && request.routeOptions.config.csrfReadOnly === true;
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    // Origin takes precedence: a valid Referer must never rescue an invalid Origin.
    let source: string | undefined;
    if (origin !== undefined) {
      if (originOf(origin) === origin) {
        source = origin;
      }
    } else if (referer !== undefined) {
      source = originOf(referer);
    }
    const missingSource = origin === undefined && referer === undefined;
    if (!(readOnly && missingSource) && (!source || !allowed.has(source))) {
      return reply.code(403).send({ message: 'Untrusted request origin' });
    }
    if (
      !readOnly &&
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      return reply.code(415).send({ message: 'Content-Type must be application/json' });
    }
  });
}
