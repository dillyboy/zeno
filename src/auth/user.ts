import { Schema, type Connection, type Model } from 'mongoose';

interface User {
  name: string;
  email: string;
  password: string;
}

const userSchema = new Schema<User>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: true, select: false },
  },
  { collection: 'users', autoCreate: false, autoIndex: false },
);

export function findUserByEmail(connection: Connection, email: string) {
  const db = connection.useDb('sample_mflix', { useCache: true });
  const User =
    (db.models.AuthUser as Model<User> | undefined) ?? db.model<User>('AuthUser', userSchema);
  return User.findOne({ email }).select('+password').lean().exec();
}
