import { expect, it, vi } from 'vite-plus/test';
import mongoose, { Schema } from 'mongoose';
import { createSession, deactivateSession, rotateSession } from './session.ts';

it('upserts by user and requires the current active token to log out', async () => {
  const connection = mongoose.createConnection();
  const db = connection.useDb('sample_mflix', { useCache: true });
  const model = db.model(
    'AuthSession',
    new Schema(
      {
        user_id: String,
        jwt: String,
        active: Boolean,
        refreshTokenHash: String,
        refreshExpiresAt: Date,
      },
      { autoCreate: false, autoIndex: false, collection: 'sessions' },
    ),
  );
  const update = vi.spyOn(model.collection, 'updateOne').mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  try {
    const tokens = {
      token: 'new-token',
      refreshTokenHash: 'new-hash',
      refreshExpiresAt: new Date(Date.now() + 60000),
    };
    await createSession(connection, 'test@example.com', tokens);
    expect(update).toHaveBeenCalledWith(
      { user_id: 'test@example.com' },
      expect.objectContaining({
        $set: {
          jwt: 'new-token',
          active: true,
          refreshTokenHash: tokens.refreshTokenHash,
          refreshExpiresAt: tokens.refreshExpiresAt,
        },
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(await rotateSession(connection, 'test@example.com', 'old-hash', tokens)).toBe(true);
    expect(update).toHaveBeenLastCalledWith(
      {
        user_id: 'test@example.com',
        active: true,
        refreshTokenHash: 'old-hash',
        refreshExpiresAt: { $gt: expect.any(Date) },
      },
      {
        $set: {
          jwt: tokens.token,
          refreshTokenHash: tokens.refreshTokenHash,
          refreshExpiresAt: tokens.refreshExpiresAt,
        },
      },
      expect.any(Object),
    );
    expect(await deactivateSession(connection, 'test@example.com', 'new-token')).toBe(true);
    expect(update).toHaveBeenLastCalledWith(
      { user_id: 'test@example.com', jwt: 'new-token', active: true },
      { $set: { active: false }, $unset: { refreshTokenHash: '', refreshExpiresAt: '' } },
      expect.any(Object),
    );
  } finally {
    update.mockRestore();
    await connection.close();
  }
});
