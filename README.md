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
response contains `token`, `refreshToken`, and `user` (ID, name, email). Invalid credentials return 401.
Login also sets `access_token` as an HttpOnly cookie. The browser stores it and
sends it automatically to this server. It uses `SameSite=Strict`, a one-hour
lifetime, and `Secure` when `NODE_ENV=production` (HTTPS required in production).
Each login issues a unique JWT valid for one hour and upserts the user's record in
`sample_mflix.sessions` with `user_id` (the user's email), `jwt`, and `active: true`.
The existing unique `user_id` index allows one session per user. Logging in again
replaces the previous token and reactivates the session, including after logout.
The implementation lives in `src/auth/` and does not modify the sample users.

## Refresh tokens

Log in again after upgrading to obtain a `refreshToken`. Use `POST /auth/refresh`
under **Auth** in Swagger with this body (no Bearer access token is required):

```json
{ "refreshToken": "paste-the-refreshToken-from-login-here" }
```

The response contains a new `token` (one-hour access JWT) and `refreshToken`
(valid for seven days). Save both new values: refreshing replaces both stored
credentials, and the old refresh token cannot be used again. Refresh also replaces
the access cookie automatically; continue using the latest `refreshToken` in the body.

Sessions store `refreshTokenHash` (SHA-256) and `refreshExpiresAt`, never the raw
refresh token. Refresh requires an active session and its current, unexpired
refresh credential. Invalid, expired, reused, or logged-out refresh tokens return 401. Login replaces previous refresh credentials; logout clears them.

## Logout

After logging in in Swagger, execute `POST /auth/logout` without a request body.
The browser sends the access cookie automatically. Logout clears that cookie.

It identifies the user from the verified access token and updates
only its matching active session with `active: false`. Missing, expired, invalid,
or already logged-out tokens return 401. Other users' sessions remain active.

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
