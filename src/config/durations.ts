// Read once at startup. Environment changes require a server restart.
export function positiveDuration(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
  return fallback;
}

export const sessionIdleTimeoutMs = positiveDuration(process.env.SESSION_IDLE_TIMEOUT_MS, 900_000);
export const sessionAbsoluteLifetimeMs = positiveDuration(
  process.env.SESSION_ABSOLUTE_LIFETIME_MS,
  28_800_000,
);
export const accessTokenLifetimeSeconds = positiveDuration(
  process.env.ACCESS_TOKEN_LIFETIME_SECONDS,
  900,
);
export const refreshTokenLifetimeSeconds = positiveDuration(
  process.env.REFRESH_TOKEN_LIFETIME_SECONDS,
  86_400,
);
export const databaseSelectionTimeoutMs = positiveDuration(
  process.env.DATABASE_SELECTION_TIMEOUT_MS,
  10_000,
);
export const databaseQueryTimeoutMs = positiveDuration(
  process.env.DATABASE_QUERY_TIMEOUT_MS,
  10_000,
);
