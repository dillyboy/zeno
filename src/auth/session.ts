import { Schema, type Connection, type Model } from 'mongoose';

interface Session {
  user_id: string;
  jwt: string;
  active: boolean;
  refreshTokenHash?: string;
  refreshExpiresAt?: Date;
}

const sessionSchema = new Schema<Session>(
  {
    user_id: { type: String, required: true },
    jwt: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
    refreshTokenHash: { type: String, select: false },
    refreshExpiresAt: Date,
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

export async function hasActiveSession(connection: Connection, email: string, token: string) {
  return Boolean(await sessions(connection).exists({ user_id: email, jwt: token, active: true }));
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
  await sessions(connection)
    .updateOne(
      { user_id: email },
      { $set: { ...tokenFields(tokens), active: true } },
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
  const result = await sessions(connection)
    .updateOne(
      {
        user_id: email,
        active: true,
        refreshTokenHash: previousHash,
        refreshExpiresAt: { $gt: new Date() },
      },
      { $set: tokenFields(tokens) },
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
