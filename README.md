# Zeno backend

Fastify API with TypeScript and Vite+ for formatting, linting, type checks, and tests.

## Getting started

Use Node.js 22.18+, 24.11+, or 26+ (see `package.json` for supported versions).

```sh
npm install
cp .env.example .env
```

Add your MongoDB connection string to `.env` before starting the server:

```dotenv
MONGODB_URI="mongodb+srv://username:password@cluster.example.mongodb.net/zeno"
```

Replace the example with your actual URI, including the database name. `.env` is
ignored by Git. For a local MongoDB instance, use `mongodb://127.0.0.1:27017/zeno`.

Set `JWT_SECRET` in `.env` to a random secret of at least 32 bytes. Generate one:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```dotenv
JWT_SECRET="paste-the-generated-secret-here"
```

Keep this secret stable across restarts. Changing it invalidates previously issued tokens.

```sh
npm run dev
```

The API listens at `http://127.0.0.1:3000`. `GET /health` returns `{"status":"ok"}`.
Swagger UI opens automatically when running `npm run dev`. You can also visit
`http://127.0.0.1:3000/docs/` and use **Try it out** to test the endpoints.
The OpenAPI specification is available at `/docs/json`. Add a `schema` to each
new route to describe its inputs and responses in Swagger UI.
Set `HOST` and `PORT` in `.env` as needed. Use `HOST=0.0.0.0` for containers.
Development uses Node's native TypeScript support and restarts on source changes.

The server connects through Mongoose before accepting HTTP requests. Startup
fails if `MONGODB_URI` is missing or MongoDB cannot be reached within 10 seconds.
The connection closes when the server shuts down. Use `app.db.model(...)` in
routes or plugins to define models on this connection. Endpoint tests build the
app without the startup database registration, so they do not require MongoDB.

## Login

Use `POST /auth/login` under **Auth** in Swagger UI:

```json
{
  "email": "sean_bean@gameofthron.es",
  "password": "the user's original plaintext password"
}
```

The endpoint reads `sample_mflix.users` using the existing connection and verifies
the bcrypt hash. Supply the original password, not the stored hash. A successful
response contains `token`, `accessExpiresAt` (Unix milliseconds), and `user` (ID, name, email). Invalid credentials return 401. Refresh tokens are never included in JSON.
Login also sets `access_token` as an HttpOnly cookie. The browser stores it and
sends it automatically to this server. It uses `SameSite=Strict`, a 15-minute
lifetime, and `Secure` when `NODE_ENV=production` (HTTPS required in production).
Each login issues a unique access JWT valid for 15 minutes and a refresh token valid
for 24 hours, and upserts the user's record in
`sample_mflix.sessions` with `user_id` (the user's email), `jwt`, and `active: true`.
The existing unique `user_id` index allows one session per user. Logging in again
replaces the previous token and reactivates the session, including after logout.
The implementation lives in `src/auth/` and does not modify the sample users.

## Refresh tokens

Login sets both `access_token` and `refresh_token` as HttpOnly, SameSite=Strict,
Path=/ cookies. Both use Secure in production. Access lasts 15 minutes and refresh
lasts 24 hours. The browser sends them automatically; do not copy refresh tokens
into localStorage or sessionStorage.

Call `POST /auth/refresh` with cookies included (no body is needed; `{}` also
works). It rotates both cookies and returns `token` plus `accessExpiresAt` in Unix
milliseconds. The refresh credential is never returned in JSON. The optional
legacy `refreshToken` request field remains accepted for existing clients, but
cookie credentials take precedence.

Active clients should refresh around one minute before `accessExpiresAt`, with
one request at a time across tabs. Pause refresh while idle or logging out.
A 401 requires sign-in; transient failures may retry while the user is active.

Sessions store `refreshTokenHash` (SHA-256) and `refreshExpiresAt`, never the raw
refresh token. Refresh requires an active session and its current, unexpired
refresh credential. Invalid, expired, reused, or logged-out refresh tokens return 401. Login replaces previous refresh credentials; logout clears them.

## Logout

After logging in in Swagger, execute `POST /auth/logout` without a request body.
The browser sends the access cookie automatically. Logout clears that cookie.

It revokes the current session using the verified refresh cookie, even after
access expiry, and clears both cookies. Without a refresh cookie it accepts the
current access cookie or Bearer token. Invalid credentials return 401 and clear
both cookies; transient server failures preserve them for retry. Other users'
sessions remain active.

Logout also accepts `Authorization: Bearer <token>` for existing HTTP clients.

## Top movies and testing cookies in Swagger

`GET /movies/top` returns up to 100 titles from `sample_mflix.movies`, ranked by
IMDb rating descending, then votes descending, then ID. Only numeric ratings in
the 0–10 range qualify. The `year` field is a string to support year ranges.
The route requires the `access_token` cookie, a valid access JWT, and a matching
active session with the same current token. Expired, revoked, and replaced tokens
return 401. A Bearer header alone does not authenticate this route.

1. Run `npm run dev` and open `http://127.0.0.1:3000/docs/`.
2. Expand **Auth → POST /auth/login**, select **Try it out**, enter your email and
   password, and click **Execute**. The browser saves the returned cookie.
3. Expand **Movies → GET /movies/top**, select **Try it out → Execute**.
   No token copying or **Authorize** step is needed.
4. Execute **POST /auth/logout**, then execute the movies request again: it returns 401.

Keep the same hostname throughout: `localhost` and `127.0.0.1` have different
cookie storage. To inspect the cookie, use browser developer tools → Application
(or Storage) → Cookies. HttpOnly cookies are not accessible through JavaScript.
Swagger's cookie **Authorize** field cannot set browser cookies; use the login
endpoint instead. Swagger's generated curl preview may omit browser-managed cookies.

## Commands

| Command                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `npm run dev`          | Start the API with watch mode                      |
| `npm run format`       | Format files with Vite+ / Oxfmt                    |
| `npm run format:check` | Check formatting without changing files            |
| `npm run lint`         | Run Vite+ / Oxlint                                 |
| `npm run check`        | Check formatting, lint, and types                  |
| `npm run typecheck`    | Run the TypeScript compiler without emitting files |
| `npm test`             | Run the endpoint test with Vite+ / Vitest          |
| `npm run build`        | Compile the server to `dist/`                      |
| `npm start`            | Run the compiled server                            |

Run `npm run build` before `npm start`.

Install the recommended Oxc VS Code extension for formatting on save.
Tooling configuration lives in `vite.config.ts`. Fastify runs the HTTP server;
TypeScript compiles the production build.

Add routes in `src/app.ts`. Keep server startup in `src/server.ts` so tests can
exercise the API through Fastify's `inject()` without opening a network port.

References: [Vite+ checks](https://viteplus.dev/guide/check),
[Fastify](https://fastify.dev/docs/latest/).

## Reusable table search (customers example)

`POST /api/customers/search` implements [SERVER_SIDE_API.md](./SERVER_SIDE_API.md).
Log in first: this endpoint requires the access cookie and a matching active session.
Customers are read from the database named in `MONGODB_URI`, not `sample_mflix`.
No collection, indexes, or sample records are created. A missing collection returns
an empty page; upload data later through MongoDB Compass or your import tooling.

```json
{
  "page": 1,
  "pageSize": 100,
  "sort": { "column": "amount", "direction": "descending" },
  "filters": [
    { "field": "status", "operator": "eq", "value": ["active", "pending"] },
    { "field": "amount", "operator": "between", "value": [0, 500] },
    { "field": "createdAt", "operator": "between-dates", "value": ["2026-10-01", "2026-10-17"] }
  ],
  "timeZone": "Asia/Singapore"
}
```

Sample customer document in MongoDB Extended JSON (for import):

```json
{
  "name": "Alice Tan",
  "email": "alice@example.com",
  "status": "active",
  "amount": 250,
  "createdAt": { "$date": "2026-10-10T03:30:00.000Z" }
}
```

Use BSON numbers and Dates, scalar strings, and status IDs `active`, `pending`, or
`inactive`. Missing/null/empty/whitespace fields are blank. Normalize blanks to
null on import; other invalid types should be migrated. Additional stored fields
are returned, so only expose collections whose full documents may be read by
any authenticated user. This example has no tenant ownership model.

To add a collection, define its server-owned field registry and call
`registerTableSearch(app, { url, collection, fields, tag })`, following
`src/customers/routes.ts`, then register it in `src/app.ts`. Field entries declare
`path`, `type`, optional option IDs, and optional `filterable`/`sortable` flags.
Client requests cannot choose collection names or arbitrary database paths.
The shared implementation lives in `src/table/`.

Results contain `items` (all stored fields, with `_id` mapped to string `id`) and
`pagination`. Valid out-of-range pages clamp to the final page. Sorting places
blanks last in either direction and uses `_id` as a stable tie-breaker. When
`sort` is null or omitted, no sorting is applied; MongoDB result order is not guaranteed. Text
sorting uses English case/accent-insensitive collation. Filters use literal,
case-insensitive, accent-sensitive text matching. Dates require an explicit IANA
timezone, with inclusive calendar days and daylight-saving boundaries.
`quick-ranges` behaves identically to `between-dates`: the supplied date pair is
authoritative, and `quickRange` metadata is accepted without interpreting presets.

Count and page reads are eventually consistent under concurrent writes. Queries
have a 10-second database timeout; computed blank sorting, regex searches, exact
counts, and deep page offsets can be expensive for large collections. Review
indexes against actual workloads before scaling. Upload/write endpoints are not
part of this read-only sample.

### Server-side session expiration

Sessions expire after 15 minutes without a successful authenticated API request
or token refresh, and after 8 hours from login regardless of activity. These
limits are enforced atomically in MongoDB for both API authentication and refresh.
Refresh updates activity but preserves the absolute deadline; expired sessions
cannot be revived by refreshing. Browser timers are only a user experience aid.
Duration settings live in `.env` and are read by `src/config/durations.ts`. Existing session records without
these timestamps are rejected, so users must sign in again after deployment.
Expired records may remain marked active in storage, but cannot authorize requests.

### Duration configuration

Copy the duration settings in `.env.example` to `.env`. Restart the backend after
changing them; deployment environment variables take precedence over `.env`.
Missing or invalid values fall back to the defaults below. Values must be positive
integers no greater than 2147483647.

| Variable                         | Default  | Unit         |
| -------------------------------- | -------- | ------------ |
| `SESSION_IDLE_TIMEOUT_MS`        | 900000   | milliseconds |
| `SESSION_ABSOLUTE_LIFETIME_MS`   | 28800000 | milliseconds |
| `ACCESS_TOKEN_LIFETIME_SECONDS`  | 900      | seconds      |
| `REFRESH_TOKEN_LIFETIME_SECONDS` | 86400    | seconds      |
| `DATABASE_SELECTION_TIMEOUT_MS`  | 10000    | milliseconds |
| `DATABASE_QUERY_TIMEOUT_MS`      | 10000    | milliseconds |

Cookie lifetimes use the matching token settings. Absolute session deadlines are
stored at login, so changed absolute lifetimes apply to new logins. Idle timeout
changes apply to existing sessions after restart. Keep the frontend warning plus
countdown aligned with the backend idle limit, and its refresh lead time shorter
than the access-token lifetime.

### CSRF and browser origins

Set `CSRF_ALLOWED_ORIGINS` in `.env` to comma-separated exact browser origins
(scheme, hostname and port, without paths or trailing slashes). It is required in
production; wildcard and malformed entries are rejected at startup. For example:

```dotenv
CSRF_ALLOWED_ORIGINS=https://tasks.example.com
```

Development defaults include localhost and 127.0.0.1 on ports 5173, 3000 and 6006.
Remove unused origins in deployed environments. Configuration is read when the
app starts, so restart after changes. CORS remains disabled; this allowlist does
not enable cross-origin JavaScript access. Use the frontend's same-origin proxy.

All non-safe methods require a trusted Origin, or a trusted Referer when Origin
is absent, and `Content-Type: application/json`. Missing, null, malformed, and
untrusted sources receive 403 before authentication or cookie changes. Unsupported
content types receive 415. Login, refresh and logout clients must send a JSON body;
use `{}` for refresh/logout when no fields are needed. Command-line clients must
also send the trusted Origin and JSON content type. Reverse proxies must preserve
browser Origin/Referer rather than replacing them or trusting a rewritten Host.

Only explicitly marked read-only POST searches (`config.csrfReadOnly`) may omit
both source headers, supporting the frontend server loader. A supplied untrusted
source is still rejected. Do not use this exemption for mutations, authentication,
or credential rotation; future POST/PUT/PATCH/DELETE routes are protected by default.
SameSite=Strict, HttpOnly and production Secure cookies remain additional defenses.

### Login brute-force protection

`POST /auth/login` permits 20 requests per client IP and 5 validated requests per
normalized email address per 15-minute fixed window. All admitted attempts count,
including successful logins, so parallel requests and successful logins cannot
reset the budget. Account keys are trimmed, lowercased, and SHA-256 hashed.
Unknown and existing accounts receive identical throttling responses.

Excess requests return `429`, `Cache-Control: no-store`, and `Retry-After` in
seconds before database lookup or bcrypt comparison. IP limiting also runs before
body parsing/validation. Rejected attempts do not extend the window. Account
throttling temporarily also blocks legitimate sign-ins to an attacked account;
existing sessions, refresh, logout, and health checks remain available.

Counters are scoped to one app process, reset on restart, and hold at most 10,000
IP and 10,000 account buckets. At capacity, new keys are rejected until expired
entries can be reclaimed; active entries are never evicted to bypass limits.
Before deploying multiple processes/replicas, replace these counters with a shared
atomic store such as Redis and add edge request/concurrency limits. These limits
reduce password guessing; they do not replace MFA or prevent all distributed attacks.

Fastify currently leaves `trustProxy` disabled, so spoofed `X-Forwarded-For` headers
do not change the IP bucket. Behind Vite or another reverse proxy, requests share
the proxy IP budget. Configure only known proxy addresses in Fastify and ensure
the proxy overwrites forwarding headers before relying on end-user IP limits.
Never enable unrestricted `trustProxy` on a directly reachable backend.
