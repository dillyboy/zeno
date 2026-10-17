# Table API contract: Node.js and MongoDB

This is a proposed backend contract for the existing Table component. It documents the current UI payloads and the database queries needed to move filtering, sorting, and pagination to the server. It does not implement a backend or change the component.

The example resource is `records`, with `name` (string), `status` (string option ID), `amount` (number), and `createdAt` (date). Replace these fields with the actual resource schema; the Table has no fixed business schema.

## 1. What the current table does

Relevant implementation: [Table.tsx](./Table.tsx), [TableContext.ts](./TableContext.ts), [Column.tsx](./Column/Column.tsx), [table.helpers.ts](./table.helpers.ts), [useTableData.ts](./useTableData.ts), and [Footer.tsx](./Footer/Footer.tsx).

- `TableBody` renders the supplied rows. `useTableData` currently filters and sorts a complete dataset in a browser worker, then slices it locally.
- Each filter is `{ field, operator, value }`; quick date ranges also contain `quickRange`. Send filters unchanged to the backend, including the `quick-ranges` operator and its resolved date pair. Different columns are combined with **AND**. Values in an `in` filter or multi-option selection are combined with **OR**.
- The UI maintains at most one filter per field. Reset removes that filter entirely; it does not send `value: null`.
- Sorting has one descriptor: `{ column, direction: 'ascending' | 'descending' }`. The cycle is ascending → descending → cleared. Cleared sorting is `undefined` in React and should become `null` on the wire.
- Pages are **1-based**. The footer offers page sizes **50, 100, 250, 500, 1000**, with a default of 100.
- Text and option filtering ignore case. Numeric ranges include both endpoints. Dates are compared by local calendar day. Blank means missing, `null`, empty string, or whitespace-only string. Every non-blank operator excludes blank rows, including not-equal.
- Sorting uses typed numbers/dates and locale-aware text comparison. Missing/invalid values appear last in both directions. Equal sort values currently keep source-array order.

## 2. Request

Use a read-only search endpoint with a JSON body so arrays and ranges do not need custom URL encoding:

```http
POST /api/records/search
Content-Type: application/json
```

```json
{
  "page": 2,
  "pageSize": 100,
  "sort": { "column": "amount", "direction": "descending" },
  "filters": [
    { "field": "name", "operator": "contains", "value": "alice" },
    { "field": "status", "operator": "eq", "value": ["active", "pending"] },
    { "field": "amount", "operator": "between", "value": [100, 500] },
    {
      "field": "createdAt",
      "operator": "between-dates",
      "value": ["2026-10-01", "2026-10-17"]
    }
  ],
  "timeZone": "Asia/Singapore"
}
```

Defaults for omitted keys: `page: 1`, `pageSize: 100`, `sort: null`, `filters: []`. Require an IANA `timeZone` whenever date filters are present. The frontend should send its agreed display timezone, for example `Intl.DateTimeFormat().resolvedOptions().timeZone`. Do not infer it from the backend machine timezone. A product with a fixed business timezone may use that timezone consistently instead.

Pagination alone:

```json
{ "page": 1, "pageSize": 50, "sort": null, "filters": [] }
```

The server owns the field names, data types, permitted operators, option IDs, and MongoDB field paths. Never accept column types, collection names, MongoDB operators, or arbitrary sort paths from the caller.

## 3. Response

```json
{
  "items": [
    {
      "id": "68e000000000000000000001",
      "name": "Alice Tan",
      "status": "active",
      "amount": 250,
      "createdAt": "2026-10-10T03:30:00.000Z"
    }
  ],
  "pagination": {
    "requestedPage": 2,
    "currentPage": 2,
    "pageSize": 100,
    "totalItems": 101,
    "totalPages": 2
  }
}
```

`items` contains only the requested page after filtering and sorting. `totalItems` counts **all matching documents before pagination**, not the collection size or page length. `totalPages = Math.max(1, Math.ceil(totalItems / pageSize))`. Clamp a valid but out-of-range page to `totalPages`, matching the existing hook. Return the effective page as `currentPage` so the UI can update its state.

An empty result is HTTP 200 with `items: []`, `totalItems: 0`, `totalPages: 1`, and `currentPage: 1`. Serialize `_id` to a stable string `id`, and BSON Dates to ISO timestamps. Return all stored document fields, with `_id` represented as `id`. Remove only temporary fields introduced by the table query, such as `__tableBlank`.

## 4. Filter-to-MongoDB mapping

These examples assume scalar, consistently typed MongoDB fields: strings for text/option IDs, BSON numbers for numeric columns, and BSON Dates for timestamp columns. Normalize blank strings to `null` when writing, including legacy whitespace-only values. Keep nonblank strings unchanged: the existing text helper does not trim them before comparisons.

Do not store numeric values as strings or timestamps as arbitrary display strings. The local helper tolerates some such values; this API deliberately requires typed storage. Migrate legacy data before using these queries. Arrays, embedded objects, and booleans require separately defined field contracts.

### Text

Let `f` be the allowlisted database field, `v` the supplied string, and `e` the regex-escaped version of `v`. Regex options are `i` for case-insensitive matching. Escape input so `a.b` searches for a literal dot.

| UI operator  | Value shape        | MongoDB predicate (before blank exclusion)                               |
| ------------ | ------------------ | ------------------------------------------------------------------------ |
| `eq`         | `"Alice"`          | `{ [f]: { $regex: '^' + e + '(?![\\s\\S])', $options: 'i' } }`           |
| `neq`        | `"Alice"`          | `{ [f]: { $not: { $regex: '^' + e + '(?![\\s\\S])', $options: 'i' } } }` |
| `contains`   | `"ali"`            | `{ [f]: { $regex: e, $options: 'i' } }`                                  |
| `startswith` | `"Al"`             | `{ [f]: { $regex: '^' + e, $options: 'i' } }`                            |
| `endswith`   | `"ice"`            | `{ [f]: { $regex: e + '(?![\\s\\S])', $options: 'i' } }`                 |
| `in`         | `["Alice", "Bob"]` | `{ $or: [exactMatch(f, 'Alice'), exactMatch(f, 'Bob')] }`                |
| `blank`      | `""`               | `{ [f]: null }` after blank normalization                                |

`(?![\s\S])` is an absolute end assertion. A plain `$` anchor can also match before a final newline, which would differ from JavaScript `endsWith`/equality.

For every non-blank text filter add `{ [f]: { $type: 'string', $nin: [null, ''] } }`. This matters especially for `neq`: MongoDB negative predicates can otherwise include missing fields. With unnormalized legacy blanks, use an additional whitespace check or migrate first. MongoDB documents regex behavior and limitations in its [regex reference](https://www.mongodb.com/docs/manual/reference/operator/query/regex/).

### Options

OptionsFilter uses **`eq` for both modes**, unlike StringFilter's `in`:

```json
{ "field": "status", "operator": "eq", "value": "active" }
```

```json
{ "field": "status", "operator": "eq", "value": ["active", "pending"] }
```

Match one option with the same case-insensitive exact predicate used for text. Match multiple options with `$or` over exact predicates. Send option **IDs**, not labels, and validate against backend-owned allowed IDs. Do not interpret multiple values as an array stored in the document. If canonical option IDs are always stored in one case, normalize incoming IDs and use `$in` for a more index-friendly query.

### Numbers

| UI operator             | Value        | MongoDB predicate                                  |
| ----------------------- | ------------ | -------------------------------------------------- |
| `equal`                 | `100`        | `{ amount: { $eq: 100 } }`                         |
| `not-equal`             | `100`        | `{ amount: { $ne: 100 } }` plus numeric type guard |
| `greater-than`          | `100`        | `{ amount: { $gt: 100 } }`                         |
| `greater-than-or-equal` | `100`        | `{ amount: { $gte: 100 } }`                        |
| `less-than`             | `100`        | `{ amount: { $lt: 100 } }`                         |
| `less-than-or-equal`    | `100`        | `{ amount: { $lte: 100 } }`                        |
| `between`               | `[100, 500]` | `{ amount: { $gte: 100, $lte: 500 } }`             |
| `blank`                 | `""`         | `{ amount: null }` after normalization             |

Add `{ amount: { $type: 'number' } }` to non-blank predicates. Zero is a valid number, not blank. Accept only finite JSON numbers; reject numeric strings and reversed ranges.

### Dates

`between-dates` sends `[start, end]` in `YYYY-MM-DD` format, inclusive of both calendar dates. Convert to a half-open BSON timestamp range:

```js
{
  createdAt: {
    $gte: new Date('2026-09-30T16:00:00.000Z'),
    $lt: new Date('2026-10-17T16:00:00.000Z')
  }
}
```

This matches October 1 through October 17 in `Asia/Singapore`. The upper bound is midnight at the start of October 18. Do not compare a timestamp to the end date's midnight, which would omit most of that day. Add calendar days in the chosen timezone, rather than adding 86,400,000 milliseconds, to support daylight-saving transitions.

`in` means OR across whole calendar days, **not** `$in` across midnight instants:

```json
{
  "field": "createdAt",
  "operator": "in",
  "value": ["2026-10-01", "2026-10-17"]
}
```

```js
{
  $or: [
    { createdAt: { $gte: startOfOctober1, $lt: startOfOctober2 } },
    { createdAt: { $gte: startOfOctober17, $lt: startOfOctober18 } },
  ];
}
```

Quick-range presets are resolved by the frontend when Apply Filter is pressed. Send the filter unchanged:

```json
{
  "field": "createdAt",
  "operator": "quick-ranges",
  "quickRange": "last-7-days",
  "value": ["2026-10-11", "2026-10-17"]
}
```

The backend accepts `quick-ranges` as an alias of `between-dates` and queries the supplied start/end dates identically. It must not maintain a preset list, validate preset names, or calculate preset dates. `quickRange` is frontend metadata; accept it without using it to build the query. Validate the date pair and timezone just as for a manual date range.

The frontend sends its filters directly, without mapping operators or removing metadata:

```ts
const request = {
  page,
  pageSize,
  sort: sortDescriptor ?? null,
  filters,
  timeZone,
};
```

`blank` uses `{ createdAt: null }`. Other date predicates require BSON Date storage and exclude null/missing values naturally.

## 5. Node.js query compiler

The following ES module example uses the native `mongodb` driver and Day.js for timezone conversion (`npm install mongodb dayjs` in the backend project). It assumes the request has passed the validation rules in section 7. The field registry is illustrative and must be defined per endpoint.

```js
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const fields = new Map([
  ["name", { path: "name", type: "string" }],
  [
    "status",
    {
      path: "status",
      type: "options",
      options: ["active", "pending", "inactive"],
    },
  ],
  ["amount", { path: "amount", type: "number" }],
  ["createdAt", { path: "createdAt", type: "date" }],
]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const absoluteEnd = "(?![\\s\\S])";
const regex = (field, pattern) => ({
  [field]: { $regex: pattern, $options: "i" },
});
const exactMatch = (field, value) =>
  regex(field, "^" + escapeRegex(value) + absoluteEnd);

function dayStart(value, timeZone) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Expected YYYY-MM-DD");
  }
  if (!dayjs.utc(value, "YYYY-MM-DD", true).isValid()) {
    throw new Error("Invalid calendar date");
  }
  return dayjs.tz(value, "YYYY-MM-DD", timeZone).startOf("day");
}

function dateRange(field, start, end, timeZone) {
  const from = dayStart(start, timeZone);
  const through = dayStart(end, timeZone);
  if (from.valueOf() > through.valueOf())
    throw new Error("Reversed date range");
  // Advance the calendar label, then parse midnight in the target zone again.
  // This recalculates its offset if daylight saving changes overnight.
  const nextDay = dayjs
    .utc(end, "YYYY-MM-DD", true)
    .add(1, "day")
    .format("YYYY-MM-DD");
  const until = dayStart(nextDay, timeZone);
  return {
    [field]: { $gte: from.toDate(), $lt: until.toDate() },
  };
}

function compileFilter(filter, timeZone) {
  const config = fields.get(filter.field);
  if (!config) throw new Error("Unknown field");
  const field = config.path;
  const { operator, value } = filter;
  if (operator === "blank") return { [field]: null };

  if (config.type === "date") {
    if (operator === "in") {
      return { $or: value.map((day) => dateRange(field, day, day, timeZone)) };
    }
    if (operator === "between-dates" || operator === "quick-ranges") {
      return dateRange(field, value[0], value[1], timeZone);
    }
    throw new Error("Unsupported date operator");
  }

  if (config.type === "number") {
    const operators = {
      equal: "$eq",
      "not-equal": "$ne",
      "greater-than": "$gt",
      "greater-than-or-equal": "$gte",
      "less-than": "$lt",
      "less-than-or-equal": "$lte",
    };
    if (operator !== "between" && !Object.hasOwn(operators, operator)) {
      throw new Error("Unsupported numeric operator");
    }
    const condition =
      operator === "between"
        ? { $gte: value[0], $lte: value[1] }
        : { [operators[operator]]: value };
    return { $and: [{ [field]: { $type: "number" } }, { [field]: condition }] };
  }

  const nonblank = { [field]: { $type: "string", $nin: [null, ""] } };
  let predicate;
  if ((config.type === "options" && operator === "eq") || operator === "in") {
    const values = Array.isArray(value) ? value : [value];
    predicate = { $or: values.map((entry) => exactMatch(field, entry)) };
  } else {
    const escaped = escapeRegex(value);
    switch (operator) {
      case "eq":
        predicate = exactMatch(field, value);
        break;
      case "neq":
        predicate = {
          [field]: {
            $not: { $regex: "^" + escaped + absoluteEnd, $options: "i" },
          },
        };
        break;
      case "contains":
        predicate = regex(field, escaped);
        break;
      case "startswith":
        predicate = regex(field, "^" + escaped);
        break;
      case "endswith":
        predicate = regex(field, escaped + absoluteEnd);
        break;
      default:
        throw new Error("Unsupported text operator");
    }
  }
  return { $and: [nonblank, predicate] };
}

function compileMatch(filters, timeZone) {
  if (filters.length === 0) return {};
  return { $and: filters.map((filter) => compileFilter(filter, timeZone)) };
}
```

Use the exact same compiled filters for rows and count. This example does not assume a tenant or user-ownership model. If the application already restricts record access, apply its existing access rules consistently to both queries.

The compiler intentionally has no generic MongoDB object pass-through. Validation is required before calling it; its few defensive checks are not a complete request validator. Day.js documents [timezone parsing](https://day.js.org/docs/en/timezone/parsing-in-zone) and [strict date parsing](https://day.js.org/docs/en/parse/string-format). These are library functions used inside Node.js, not external API calls.

## 6. Sorting and page execution

For a non-nullable typed field, the basic native-driver query is:

```js
const match = compileMatch(filters, timeZone);
const totalItems = await collection.countDocuments(match);
const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
const currentPage = Math.min(page, totalPages);
const skip = (currentPage - 1) * pageSize;
const order = sort?.direction === "descending" ? -1 : 1;
const mongoSort = sort
  ? { [fields.get(sort.column).path]: order, _id: 1 }
  : { _id: 1 };

const rows = await collection
  .find(match)
  .sort(mongoSort)
  .skip(skip)
  .limit(pageSize)
  .toArray();
```

This is the order of operations: **filter → count → clamp page → sort → skip → limit**. Use `countDocuments(match)`, not `estimatedDocumentCount()`, for filtered totals. The native driver documents [cursor pagination](https://www.mongodb.com/docs/drivers/node/current/crud/query/specify-documents-to-return/) and [counting](https://www.mongodb.com/docs/drivers/node/current/crud/query/count/).

Always append a unique tie-breaker (`_id`) to the sort. Without one, rows with equal sort values may change order between page requests. For cleared sorting, use `_id: 1`; databases have no equivalent of the browser's original source-array order. If original business order matters, store an explicit sequence field and use it plus `_id` instead.

### Preserve blanks-last sorting

A plain MongoDB sort does not reproduce blanks-last in both directions. For nullable fields, use the following pipeline after counting/clamping as above. This assumes normalized, schema-validated storage; invalid legacy values must be migrated first.

```js
const sortStages = [];
if (sort) {
  const field = fields.get(sort.column).path;
  sortStages.push(
    {
      $set: {
        __tableBlank: {
          $cond: [{ $eq: [{ $ifNull: ["$" + field, null] }, null] }, 1, 0],
        },
      },
    },
    { $sort: { __tableBlank: 1, [field]: order, _id: 1 } },
  );
} else {
  sortStages.push({ $sort: { _id: 1 } });
}

// Return all stored fields; remove only the temporary sort helper.
const rows = await collection
  .aggregate(
    [
      { $match: match },
      ...sortStages,
      { $skip: skip },
      { $limit: pageSize },
      { $unset: "__tableBlank" },
    ],
    {
      collation: { locale: "en", strength: 1 },
      maxTimeMS: 10000,
    },
  )
  .toArray();

return {
  items: rows.map(({ _id, ...row }) => ({ ...row, id: _id.toHexString() })),
  pagination: {
    requestedPage: page,
    currentPage,
    pageSize,
    totalItems,
    totalPages,
  },
};
```

The example assumes ObjectId `_id` values. Adapt serialization if the collection uses another ID type. Reserve `__tableBlank` as an internal name.

Choose a fixed collation for text sorting and matching indexes. `locale: 'en', strength: 1` gives case/accent-insensitive text ordering; it approximates `Intl.Collator(undefined, { sensitivity: 'base' })`, whose actual locale depends on the browser. Exact cross-environment ordering requires agreeing on a locale on both sides. Regex filtering remains case-insensitive and accent-sensitive; collation does not make `$regex` accent-insensitive.

Count and page queries are separate reads. Concurrent inserts/deletes can cause count/page drift, and deterministic sorting cannot prevent page shifts when records change. If one consistent snapshot is required, execute both reads in a supported MongoDB transaction with snapshot read concern and the same session; pass that session to both operations. For ordinary browsing, document eventual consistency and refresh/retry when a page becomes empty after concurrent deletion.

## 7. Validation and errors

Implement a request schema (for example with your backend's existing validation library) before the compiler:

- Require an object; reject unexpected keys and raw operator objects. Bound the JSON body, e.g. 64 KB.
- `page` must be a positive safe integer; `pageSize` must be one of `50, 100, 250, 500, 1000`. Also verify the computed offset is a safe integer. Reject invalid input rather than silently coercing it.
- `sort` is `null` or an object with an allowlisted sortable string `column` and exactly one of the two supported directions. No multi-column client sort.
- `filters` is an array, e.g. at most 20 entries, with no duplicate fields. Permit only filterable registry fields and the operators documented for that type. Options accept only `eq`; their IDs must be known to the backend. Disallow filtering/sorting action columns such as `button-group`.
- Text scalar values must be nonempty strings (except `blank`); set a maximum, e.g. 256 characters. Do not accept objects or caller-supplied regex flags. Reject whitespace-only search values as a proposed API restriction; the current UI can emit some of these, so show the validation message in the frontend.
- Membership arrays must be nonempty, e.g. at most 100 strings, each within the text/date limit. Validate every item, then deduplicate. Never silently ignore an invalid filter, which could broaden results.
- Numeric values must be finite numbers. `between` requires exactly two numbers with start ≤ end. Do not treat `0` as missing.
- Dates must be real, strictly formatted `YYYY-MM-DD` values. Ranges require exactly two valid ordered dates. Validate the IANA timezone. The backend accepts `between-dates`, `quick-ranges`, `in`, and `blank` for dates; it has no preset IDs or preset validation.
- `blank` requires `value: ''`; reset is represented by the absence of a filter. The built-in OptionsFilter has no blank operator.

Return HTTP 400 for request errors, with a stable machine code and field path, for example:

```json
{
  "error": {
    "code": "INVALID_TABLE_QUERY",
    "message": "Range start must not exceed range end.",
    "details": [
      { "path": "filters[0].value", "message": "Expected start <= end." }
    ]
  }
}
```

Use the application's existing authentication/error conventions for 401/403, and a generic 500 response for unexpected database errors. Log diagnostic details server-side.

## 8. Frontend integration when server mode is added

1. Keep `filters`, `sortDescriptor`, page, and page size in parent state. Send the **complete** query state on every request, passing filters unchanged, including quick-range operators and resolved dates.
2. Pass the same `filtersChanged` handler to each filterable `Column`; it receives the entire next filter array. There is no table-level `onFiltersChange` prop today. Set the controlled `Table.filters` and reset page to 1 in that handler.
3. Use `Table.sortChanged` and controlled `Table.sortDescriptor` for sorting. Convert cleared `undefined` to `null` in JSON. Table currently invokes the page reset on sort changes; keep the parent's updates coordinated to avoid duplicate requests.
4. Reset page to 1 when page size changes. A normal page change retains filters and sorting.
5. Fetch with an AbortController or request sequence guard, so an older response cannot overwrite newer query results. Set `Table.isLoading` during the request and show errors separately from a successful empty state.
6. Pass `response.items` directly to `TableBody`. Do not run the server page through `useTableData` or `filterTableData`, and do not slice it again.
7. Map response metadata to the controlled footer:

```tsx
pagination={{
  selectedPage: response.pagination.currentPage,
  total: response.pagination.totalPages, // total means pages, not rows
  totalItems: response.pagination.totalItems,
  pageSize: response.pagination.pageSize,
  onPageChange: handlePageChange,
  onPageSizeChange: handlePageSizeChange,
}}
```

Update parent page state from the effective response page without creating a refetch loop. The current Table clears selection when filters, sorting, page, or page size change; selecting all is a page-level operation, not permission to act on all matching database rows.

## 9. Indexes and acceptance checks

Start with indexes for actual common access patterns, for example status + amount + ID, or createdAt + ID:

```js
await collection.createIndex({ status: 1, amount: -1, _id: 1 });
await collection.createIndex({ createdAt: -1, _id: 1 });
```

These are workload examples, not indexes that accelerate every arbitrary filter/sort combination. Confirm query plans with `explain('executionStats')`. Computed blank ranks prevent ordinary index-backed sorting; for large collections, materialize blank ranks on writes and index the required sort pattern. Text sort indexes must use the query's collation. Unanchored/case-insensitive regex searches and exact counts may scan many documents; consider indexed normalized search fields or a dedicated search design when needed. Large `skip` offsets also become expensive; cursor pagination would require a separate API/UI contract because this footer supports arbitrary page numbers.

Before connecting the frontend, verify:

- No filters, multiple ANDed filters, every operator, reset, one/multiple option IDs, and date membership across separate days.
- Case-insensitive text; regex metacharacters as literal input; zero/negative numbers; inclusive range endpoints.
- Missing/null/normalized whitespace blanks; not-equal excluding blanks; blanks last for both sort directions; repeated sort values across page boundaries.
- Timezone boundaries, the entire last date, daylight-saving changes, and `quick-ranges` using the supplied date pair identically to `between-dates`, without interpreting preset metadata.
- First/last/out-of-range pages, all five page sizes, empty results, filtered totals, and stable string row IDs.
- Unknown fields/operators, operator injection attempts, malformed values, reversed ranges, oversized requests, and identical filters on both count and rows.
- Concurrent edits under the chosen consistency policy and stale frontend response cancellation.
