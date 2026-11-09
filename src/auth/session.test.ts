import { expect, it, vi } from 'vite-plus/test';
import mongoose, { Schema } from 'mongoose';
import {
  hasActiveSession,
  sessionIdleTimeoutMs,
  sessionAbsoluteLifetimeMs,
  createSession,
  deactivateSession,
  deactivateRefreshSession,
  rotateSession,
} from './session.ts';

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
        lastActivityAt: Date,
        absoluteExpiresAt: Date,
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
          lastActivityAt: expect.any(Date),
          absoluteExpiresAt: expect.any(Date),
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
        lastActivityAt: { $gt: expect.any(Date) },
        absoluteExpiresAt: { $gt: expect.any(Date) },
        refreshTokenHash: 'old-hash',
        refreshExpiresAt: { $gt: expect.any(Date) },
      },
      {
        $max: { lastActivityAt: expect.any(Date) },
        $set: {
          jwt: tokens.token,
          refreshTokenHash: tokens.refreshTokenHash,
          refreshExpiresAt: tokens.refreshExpiresAt,
        },
      },
      expect.any(Object),
    );
    const rotatedUpdate = update.mock.calls.at(-1)!;
    expect(rotatedUpdate[1]).toEqual(
      expect.not.objectContaining({
        $set: expect.objectContaining({ absoluteExpiresAt: expect.anything() }),
      }),
    );
    await hasActiveSession(connection, 'test@example.com', 'new-token');
    expect(update).toHaveBeenLastCalledWith(
      {
        user_id: 'test@example.com',
        jwt: 'new-token',
        active: true,
        lastActivityAt: { $gt: expect.any(Date) },
        absoluteExpiresAt: { $gt: expect.any(Date) },
      },
      { $max: { lastActivityAt: expect.any(Date) } },
      expect.any(Object),
    );
    update.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });
    expect(await hasActiveSession(connection, 'test@example.com', 'expired-token')).toBe(false);
    expect(sessionAbsoluteLifetimeMs).toBe(8 * 60 * 60 * 1000);
    expect(await deactivateSession(connection, 'test@example.com', 'new-token')).toBe(true);
    expect(update).toHaveBeenLastCalledWith(
      { user_id: 'test@example.com', jwt: 'new-token', active: true },
      { $set: { active: false }, $unset: { refreshTokenHash: '', refreshExpiresAt: '' } },
      expect.any(Object),
    );
    expect(await deactivateRefreshSession(connection, 'test@example.com', 'current-hash')).toBe(
      true,
    );
    expect(update).toHaveBeenLastCalledWith(
      { user_id: 'test@example.com', refreshTokenHash: 'current-hash', active: true },
      { $set: { active: false }, $unset: { refreshTokenHash: '', refreshExpiresAt: '' } },
      expect.any(Object),
    );
  } finally {
    update.mockRestore();
    await connection.close();
  }
});
