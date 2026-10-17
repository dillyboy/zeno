import mongoose, { type Connection } from 'mongoose';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: Connection;
  }
}

export function registerDatabase(app: FastifyInstance, uri: string | undefined) {
  if (!uri?.trim()) {
    throw new Error('MONGODB_URI is required. Add your MongoDB connection string to .env.');
  }

  const connection = mongoose.createConnection();
  app.decorate('db', connection);

  connection.on('error', () => {
    app.log.error('MongoDB connection error');
  });
  connection.on('disconnected', () => {
    app.log.warn('MongoDB disconnected');
  });

  app.addHook('onClose', async () => {
    await connection.close();
  });

  app.addHook('onReady', async () => {
    try {
      await connection.openUri(uri, {
        serverSelectionTimeoutMS: 10000,
        bufferCommands: false,
      });
      app.log.info('MongoDB connected');
    } catch {
      // Driver errors may contain connection details; keep credentials out of logs.
      throw new Error('Unable to connect to MongoDB. Check MONGODB_URI and database access.');
    }
  });
}
