import { registerCustomerRoutes } from './customers/routes.ts';
import Fastify, { type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerAuthRoutes } from './auth/routes.ts';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { accessCookieName } from './auth/cookies.ts';
import { registerMovieRoutes } from './movies/routes.ts';

export async function buildApp(
  options: FastifyServerOptions = {},
  jwtSecret = process.env.JWT_SECRET,
) {
  if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes. Set it in .env.');
  }
  const app = Fastify(options);
  await app.register(cookie);
  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '1h' },
    verify: { algorithms: ['HS256'] },
    cookie: { cookieName: accessCookieName, signed: false },
  });

  app.addHook('onRoute', (route) => {
    if (route.url === '/docs' || route.url.startsWith('/docs/')) {
      route.logLevel = 'silent';
    }
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Zeno API', version: '0.1.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: accessCookieName },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { tryItOutEnabled: true, withCredentials: true },
  });

  registerAuthRoutes(app);
  registerMovieRoutes(app);
  registerCustomerRoutes(app);

  app.get(
    '/health',
    {
      schema: {
        summary: 'Check API health',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['ok'] } },
          },
        },
      },
    },
    (_request, reply) => reply.send({ status: 'ok' }),
  );

  return app;
}
