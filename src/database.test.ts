import { expect, it, vi } from 'vite-plus/test';
import mongoose from 'mongoose';
import Fastify from 'fastify';
import { registerDatabase } from './database.ts';

it('requires a MongoDB URI', async () => {
  const app = Fastify();
  try {
    expect(() => registerDatabase(app, undefined)).toThrow('MONGODB_URI is required');
    expect(() => registerDatabase(app, ' ')).toThrow('MONGODB_URI is required');
  } finally {
    await app.close();
  }
});

it('connects during readiness and closes on shutdown', async () => {
  const connection = mongoose.createConnection();
  const open = vi.spyOn(connection, 'openUri').mockResolvedValue(connection);
  const close = vi.spyOn(connection, 'close').mockResolvedValue();
  const create = vi.spyOn(mongoose, 'createConnection').mockReturnValue(connection);
  const app = Fastify();
  try {
    registerDatabase(app, 'mongodb://127.0.0.1:27017/test');
    expect(open).not.toHaveBeenCalled();
    await app.ready();
    expect(open).toHaveBeenCalledOnce();
    expect(app.db).toBe(connection);
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await app.close();
    create.mockRestore();
    open.mockRestore();
    close.mockRestore();
  }
});

it('rejects readiness when MongoDB fails without exposing the URI', async () => {
  const connection = mongoose.createConnection();
  const open = vi.spyOn(connection, 'openUri').mockRejectedValue(new Error('secret URI'));
  const close = vi.spyOn(connection, 'close').mockResolvedValue();
  const create = vi.spyOn(mongoose, 'createConnection').mockReturnValue(connection);
  const app = Fastify();
  try {
    registerDatabase(app, 'mongodb://127.0.0.1:27017/test');
    await expect(app.ready()).rejects.toThrow('Unable to connect to MongoDB.');
  } finally {
    await app.close();
    expect(close).toHaveBeenCalledOnce();
    create.mockRestore();
    open.mockRestore();
    close.mockRestore();
  }
});
