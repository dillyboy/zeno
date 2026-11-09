import { sessionIdleTimeoutMs, sessionAbsoluteLifetimeMs } from '../config/durations.ts';
export { sessionIdleTimeoutMs, sessionAbsoluteLifetimeMs } from '../config/durations.ts';
import { Schema, type Connection, type Model } from 'mongoose';

interface Session {
  user_id: string;
  jwt: string;
  active: boolean;
  refreshTokenHash?: string;
  refreshExpiresAt?: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
}

const sessionSchema = new Schema<Session>(
  {
    user_id: { type: String, required: true },
    jwt: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
    refreshTokenHash: { type: String, select: false },
    refreshExpiresAt: Date,
    lastActivityAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
  },
  { collection: 'sessions', autoCreate: false, autoIndex: false },
);

function sessions(connection: Connection) {
  const db = connection.useDb('sample_mflix', { useCache: true });
  return (
    (db.models.AuthSession as Model<Session> | undefined) ??
    db.model<Session>('AuthSession', sessionSchema)
  );
}

// Refreshes count as activity, but can never extend the absolute deadline.

function liveSession(now: Date) {
  return {
    active: true,
    lastActivityAt: { $gt: new Date(now.getTime() - sessionIdleTimeoutMs) },
    absoluteExpiresAt: { $gt: now },
  };
}

export async function hasActiveSession(connection: Connection, email: string, token: string) {
  const now = new Date();
  const result = await sessions(connection)
    .updateOne(
      { user_id: email, jwt: token, ...liveSession(now) },
      { $max: { lastActivityAt: now } },
    )
    .exec();
  return result.matchedCount === 1;
}

interface SessionTokens {
  token: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

function tokenFields(tokens: SessionTokens) {
  return {
    jwt: tokens.token,
    refreshTokenHash: tokens.refreshTokenHash,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

export async function createSession(connection: Connection, email: string, tokens: SessionTokens) {
  const now = new Date();
  await sessions(connection)
    .updateOne(
      { user_id: email },
      {
        $set: {
          ...tokenFields(tokens),
          active: true,
          lastActivityAt: now,
          absoluteExpiresAt: new Date(now.getTime() + sessionAbsoluteLifetimeMs),
        },
      },
      { upsert: true, runValidators: true },
    )
    .exec();
}

export async function rotateSession(
  connection: Connection,
  email: string,
  previousHash: string,
  tokens: SessionTokens,
) {
  const now = new Date();
  const result = await sessions(connection)
    .updateOne(
      {
        user_id: email,
        ...liveSession(now),
        refreshTokenHash: previousHash,
        refreshExpiresAt: { $gt: now },
      },
      { $set: tokenFields(tokens), $max: { lastActivityAt: now } },
      { runValidators: true },
    )
    .exec();
  return result.modifiedCount === 1;
}

export async function deactivateSession(connection: Connection, email: string, token: string) {
  const result = await sessions(connection)
    .updateOne(
      { user_id: email, jwt: token, active: true },
      {
        $set: { active: false },
        $unset: { refreshTokenHash: '', refreshExpiresAt: '' },
      },
    )
    .exec();
  return result.modifiedCount === 1;
}

/** Revoke the current refresh credential even after its access token expires. */
export async function deactivateRefreshSession(
  connection: Connection,
  email: string,
  refreshTokenHash: string,
) {
  const result = await sessions(connection)
    .updateOne(
      { user_id: email, refreshTokenHash, active: true },
      { $set: { active: false }, $unset: { refreshTokenHash: '', refreshExpiresAt: '' } },
    )
    .exec();
  return result.modifiedCount === 1;
}
