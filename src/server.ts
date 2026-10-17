import dayjs from 'dayjs';
import { buildApp } from './app.ts';
import { registerDatabase } from './database.ts';

const app = await buildApp({
  logger: {
    stream: {
      write(line: string) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.time === 'number') {
          entry.time = dayjs(entry.time).format('YYYY-MM-DD hh:mm:ss.SSS A');
        }
        console.log(JSON.stringify(entry, null, 2));
      },
    },
  },
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

async function shutdown() {
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  registerDatabase(app, process.env.MONGODB_URI);
  const address = await app.listen({ port, host });
  const docsUrl = new URL('/docs/', address);
  if (docsUrl.hostname === '0.0.0.0' || docsUrl.hostname === '[::]') {
    docsUrl.hostname = 'localhost';
  }
  app.log.info(`Swagger UI: ${docsUrl.href}`);
  if (process.argv.includes('--open')) {
    try {
      const { default: open } = await import('open');
      await open(docsUrl.href);
    } catch (error) {
      app.log.warn({ err: error }, `Open Swagger UI manually: ${docsUrl.href}`);
    }
  }
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
