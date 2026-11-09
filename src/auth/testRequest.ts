import type { FastifyInstance, InjectOptions } from 'fastify';

/** Existing auth contracts use a trusted JSON browser request by default. */
export function injectAuth(app: FastifyInstance, options: InjectOptions) {
  return app.inject({
    ...options,
    payload: options.payload ?? {},
    headers: {
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}
