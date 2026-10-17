import { expect, it, vi } from 'vite-plus/test';
import { buildApp } from './app.ts';

vi.stubEnv('JWT_SECRET', 'test-only-secret-at-least-32-bytes-long');

it('serves the health endpoint', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});

it('silences Swagger requests while keeping API request logs', async () => {
  const logs: string[] = [];
  const app = await buildApp({
    logger: {
      stream: {
        write: (line: string) => {
          logs.push(line);
        },
      },
    },
  });
  try {
    for (const url of ['/docs', '/docs/', '/docs/json', '/docs/static/swagger-ui.css']) {
      await app.inject({ method: 'GET', url });
    }
    expect(logs).toEqual([]);

    await app.inject({ method: 'GET', url: '/health' });
    const entries = logs.map((line) => JSON.parse(line) as { msg: string });
    expect(entries.map((entry) => entry.msg)).toEqual(['incoming request', 'request completed']);
  } finally {
    await app.close();
  }
});

it('serves Swagger UI and documents the health endpoint', async () => {
  const app = await buildApp();
  try {
    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    expect(ui.body).toContain('swagger-ui');
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().paths['/health'].get.summary).toBe('Check API health');
  } finally {
    await app.close();
  }
});
