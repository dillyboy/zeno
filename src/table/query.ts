import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export interface TableField {
  path: string;
  type: 'string' | 'options' | 'number' | 'date';
  options?: readonly string[];
  filterable?: boolean;
  sortable?: boolean;
}
export type TableFields = Readonly<Record<string, TableField>>;
export class TableQueryError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = 'TableQueryError';
    this.path = path;
  }
}
function fail(path: string, message: string): never {
  throw new TableQueryError(path, message);
}
function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'Expected an object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail(path, 'Unexpected property.');
  return result;
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const end = String.raw`(?![\s\S])`;
const exact = (field: string, value: string) => ({
  [field]: { $regex: '^' + escapeRegex(value) + end, $options: 'i' },
});
const numeric: Record<string, string> = {
  equal: '$eq',
  'not-equal': '$ne',
  'greater-than': '$gt',
  'greater-than-or-equal': '$gte',
  'less-than': '$lt',
  'less-than-or-equal': '$lte',
};
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    fail(path, 'Expected a nonblank string of at most 256 characters.');
  return value;
}
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number.');
  return value;
}
function date(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !dayjs.utc(value, 'YYYY-MM-DD', true).isValid()
  )
    fail(path, 'Expected a real YYYY-MM-DD date.');
  return value;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    fail(path, 'Expected 1–100 values.');
  return value;
}
function range(field: string, start: string, through: string, zone: string) {
  const next = dayjs.utc(through).add(1, 'day').format('YYYY-MM-DD');
  return {
    [field]: {
      $gte: dayjs.tz(start, zone).startOf('day').toDate(),
      $lt: dayjs.tz(next, zone).startOf('day').toDate(),
    },
  };
}

type Predicate = Record<string, unknown>;
type TableSort = { field: TableField; direction: 1 | -1 } | null;

function parsePagination(body: Record<string, unknown>) {
  const page = body.page === undefined ? 1 : body.page;
  const pageSize = body.pageSize === undefined ? 100 : body.pageSize;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)
    fail('page', 'Expected a positive safe integer.');
  if (typeof pageSize !== 'number' || ![50, 100, 250, 500, 1000].includes(pageSize))
    fail('pageSize', 'Unsupported page size.');
  if (!Number.isSafeInteger((page - 1) * pageSize))
    fail('page', 'Page offset exceeds safe integer range.');
  return { page, pageSize };
}

function parseSort(value: unknown, fields: TableFields): TableSort {
  let sort: TableSort = null;
  if (value !== undefined && value !== null) {
    const s = object(value, 'sort', ['column', 'direction']);
    const field =
      typeof s.column === 'string' && Object.hasOwn(fields, s.column)
        ? fields[s.column]
        : undefined;
    if (!field || field.sortable === false) fail('sort.column', 'Unknown sortable field.');
    if (s.direction !== 'ascending' && s.direction !== 'descending')
      fail('sort.direction', 'Expected ascending or descending.');
    sort = { field, direction: s.direction === 'descending' ? -1 : 1 };
  }
  return sort;
}

function parseTimeZone(value: unknown): string | undefined {
  let zone: string | undefined;
  if (value !== undefined) {
    if (typeof value !== 'string' || !value) fail('timeZone', 'Expected an IANA timezone.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions();
    } catch {
      fail('timeZone', 'Invalid IANA timezone.');
    }
    zone = value;
  }
  return zone;
}

function compileDate(
  f: Record<string, unknown>,
  field: string,
  p: string,
  zone: string,
): Predicate {
  const op = f.operator;
  const v = f.value;
  const path = p + '.value';
  if (!['in', 'between-dates', 'quick-ranges'].includes(op as string))
    fail(p + '.operator', 'Unsupported date operator.');
  const values = list(v, path).map((entry, i) => date(entry, `${path}[${i}]`));
  let predicate: Predicate;
  if (op === 'in') {
    predicate = { $or: [...new Set(values)].map((day) => range(field, day, day, zone)) };
  } else {
    const [start, through] = values;
    if (values.length !== 2 || start === undefined || through === undefined || start > through) {
      fail(path, 'Expected two ordered dates.');
    }
    predicate = range(field, start, through, zone);
  }
  return { $and: [{ [field]: { $type: 'date' } }, predicate] };
}

function compileNumber(op: unknown, v: unknown, field: string, p: string): Predicate {
  const path = p + '.value';
  let condition;
  if (op === 'between') {
    const values = list(v, path).map((entry) => number(entry, path));
    const [start, through] = values;
    if (values.length !== 2 || start === undefined || through === undefined || start > through) {
      fail(path, 'Expected two ordered numbers.');
    }
    condition = { $gte: start, $lte: through };
  } else {
    if (typeof op !== 'string' || !Object.hasOwn(numeric, op))
      fail(p + '.operator', 'Unsupported numeric operator.');
    const mongoOperator = numeric[op];
    if (mongoOperator === undefined) fail(p + '.operator', 'Unsupported numeric operator.');
    condition = { [mongoOperator]: number(v, path) };
  }
  return { $and: [{ [field]: { $type: 'number' } }, { [field]: condition }] };
}

function compileMembership(c: TableField, op: unknown, v: unknown, p: string): Predicate {
  const field = c.path;
  const path = p + '.value';
  if (c.type === 'options' && op !== 'eq') fail(p + '.operator', 'Options only support eq.');
  let entries: unknown[];
  if (!Array.isArray(v) && c.type === 'options') {
    entries = [v];
  } else {
    entries = list(v, path);
  }
  const values = entries.map((entry) => text(entry, path));
  if (
    c.type === 'options' &&
    values.some(
      (entry) => !c.options?.some((option) => option.toLowerCase() === entry.toLowerCase()),
    )
  )
    fail(path, 'Unknown option ID.');
  return { $or: [...new Set(values)].map((entry) => exact(field, entry)) };
}

function compileText(op: unknown, v: unknown, field: string, p: string): Predicate {
  const path = p + '.value';
  let predicate: Predicate;
  if (!['eq', 'neq', 'contains', 'startswith', 'endswith'].includes(op as string))
    fail(p + '.operator', 'Unsupported text operator.');
  const value = text(v, path);
  const escaped = escapeRegex(value);
  if (op === 'eq') {
    predicate = exact(field, value);
  } else if (op === 'neq') {
    predicate = { [field]: { $not: { $regex: '^' + escaped + end, $options: 'i' } } };
  } else {
    let pattern = escaped;
    if (op === 'startswith') {
      pattern = '^' + escaped;
    } else if (op === 'endswith') {
      pattern = escaped + end;
    }
    predicate = { [field]: { $regex: pattern, $options: 'i' } };
  }
  return predicate;
}

function parseFilter(raw: unknown, index: number, fields: TableFields, seen: Set<string>) {
  const p = `filters[${index}]`;
  const f = object(raw, p, ['field', 'operator', 'value', 'quickRange']);
  const config =
    typeof f.field === 'string' && Object.hasOwn(fields, f.field) ? fields[f.field] : undefined;
  if (!config || config.filterable === false) fail(p + '.field', 'Unknown filterable field.');
  const fieldName = text(f.field, p + '.field');
  if (seen.has(fieldName)) fail(p + '.field', 'Duplicate filter field.');
  seen.add(fieldName);
  return { p, f, c: config };
}

function compileFilter(
  raw: unknown,
  index: number,
  fields: TableFields,
  zone: string | undefined,
  seen: Set<string>,
): Predicate {
  const { p, f, c } = parseFilter(raw, index, fields, seen);
  const op = f.operator;
  const v = f.value;
  const path = p + '.value';
  const field = c.path;
  if (c.type === 'date' && !zone) fail('timeZone', 'Date filters require an IANA timezone.');
  if (op === 'blank' && c.type !== 'options') {
    if (v !== '') fail(path, 'Blank requires an empty string.');
    return {
      $or: [{ [field]: null }, { [field]: { $type: 'string', $regex: String.raw`^\s*${end}` } }],
    };
  }
  if (c.type === 'date') {
    if (zone === undefined) fail('timeZone', 'Date filters require an IANA timezone.');
    return compileDate(f, field, p, zone);
  }
  if (c.type === 'number') return compileNumber(op, v, field, p);
  const predicate =
    c.type === 'options' || op === 'in'
      ? compileMembership(c, op, v, p)
      : compileText(op, v, field, p);
  return {
    $and: [{ [field]: { $type: 'string', $not: { $regex: String.raw`^\s*${end}` } } }, predicate],
  };
}

function compileSortStages(sort: TableSort) {
  // A wrapper keeps sort helpers outside the stored document, preserving every stored field.
  const sortStages: Record<string, unknown>[] = [];
  // $isNumber handles all BSON numeric types; whitespace strings count as blank.
  if (sort) {
    const ref = '$' + sort.field.path;
    let valid: Record<string, unknown>;
    if (sort.field.type === 'number') {
      valid = { $isNumber: ref };
    } else if (sort.field.type === 'date') {
      valid = { $eq: [{ $type: ref }, 'date'] };
    } else {
      valid = {
        $cond: [
          { $eq: [{ $type: ref }, 'string'] },
          { $ne: [{ $trim: { input: ref } }, ''] },
          false,
        ],
      };
    }
    sortStages[0] = { $replaceWith: { row: '$$ROOT', blank: { $cond: [valid, 0, 1] } } };
  }
  return sortStages;
}

/** Validate and compile only server-owned fields; never pass caller objects to MongoDB. */
export function compileTableQuery(input: unknown, fields: TableFields) {
  const body = object(input, '', ['page', 'pageSize', 'sort', 'filters', 'timeZone']);
  const { page, pageSize } = parsePagination(body);
  const sort = parseSort(body.sort, fields);
  const zone = parseTimeZone(body.timeZone);
  const filters = body.filters === undefined ? [] : body.filters;
  if (!Array.isArray(filters) || filters.length > 20)
    fail('filters', 'Expected at most 20 filters.');
  const seen = new Set<string>();
  const predicates = filters.map((raw, index) => compileFilter(raw, index, fields, zone, seen));
  const match = predicates.length ? { $and: predicates } : {};
  const sortStages = compileSortStages(sort);
  return { page, pageSize, match, sortStages, sort };
}
