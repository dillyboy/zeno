import { expect, it } from 'vite-plus/test';
import { compileTableQuery } from './query.ts';
const customerFields = {
  name: { path: 'name', type: 'string' },
  status: { path: 'status', type: 'options', options: ['active', 'pending', 'inactive'] },
  amount: { path: 'amount', type: 'number' },
  createdAt: { path: 'createdAt', type: 'date' },
} as const;

it('escapes literal regex input and ANDs typed filters', () => {
  const q = compileTableQuery(
    {
      filters: [
        { field: 'name', operator: 'contains', value: 'a.b' },
        { field: 'amount', operator: 'between', value: [0, 10] },
        { field: 'status', operator: 'eq', value: ['ACTIVE', 'pending'] },
      ],
    },
    customerFields,
  );
  expect(q.match.$and).toHaveLength(3);
  expect(JSON.stringify(q.match)).toContain('a\\\\.b');
  expect(q.pageSize).toBe(100);
});

it('resolves supplied date ranges across DST', () => {
  const q = compileTableQuery(
    {
      timeZone: 'America/New_York',
      filters: [
        {
          field: 'createdAt',
          operator: 'between-dates',
          value: ['2026-03-08', '2026-03-08'],
        },
      ],
    },
    customerFields,
  );
  const serialized = JSON.stringify(q.match);
  expect(serialized).toContain('2026-03-08T05:00:00.000Z');
  expect(serialized).toContain('2026-03-09T04:00:00.000Z');
});

it.each([
  { page: '1' },
  { page: null },
  { pageSize: 10 },
  { page: Number.MAX_SAFE_INTEGER },
  { sort: { column: '__proto__', direction: 'ascending' } },
  { filters: [{ field: 'name', operator: 'contains', value: { $ne: '' } }] },
  { filters: [{ field: 'amount', operator: 'between', value: [2, 1] }] },
  { filters: [{ field: 'status', operator: 'blank', value: '' }] },
  { filters: [{ field: 'status', operator: 'eq', value: 'unknown' }] },
  { filters: [{ field: 'createdAt', operator: 'blank', value: '' }] },
  { timeZone: 'UTC', filters: [{ field: 'createdAt', operator: 'in', value: ['2026-02-30'] }] },
  {
    filters: [
      { field: 'name', operator: 'blank', value: '' },
      { field: 'name', operator: 'eq', value: 'x' },
    ],
  },
  { collection: 'users' },
])('rejects invalid queries: %j', (input) => {
  expect(() => compileTableQuery(input, customerFields)).toThrow();
});

it.each([undefined, 'last-7-days', 'custom-frontend-preset'])(
  'treats quick-ranges identically to between-dates, ignoring preset metadata %s',
  (quickRange) => {
    const filter = { field: 'createdAt', value: ['2026-03-08', '2026-03-08'] };
    const compile = (operator: string) =>
      compileTableQuery(
        {
          timeZone: 'America/New_York',
          filters: [{ ...filter, operator, quickRange }],
        },
        customerFields,
      );
    expect(compile('quick-ranges').match).toEqual(compile('between-dates').match);
  },
);

it.each([
  { value: ['2026-03-09', '2026-03-08'], timeZone: 'UTC' },
  { value: ['2026-02-30', '2026-03-08'], timeZone: 'UTC' },
  { value: ['2026-03-08'], timeZone: 'UTC' },
  { value: ['2026-03-08', '2026-03-08'], timeZone: undefined },
  { value: ['2026-03-08', '2026-03-08'], timeZone: 'invalid-zone' },
])('validates quick-range dates and timezone: %j', ({ value, timeZone }) => {
  expect(() =>
    compileTableQuery(
      {
        timeZone,
        filters: [
          { field: 'createdAt', operator: 'quick-ranges', quickRange: 'any-preset', value },
        ],
      },
      customerFields,
    ),
  ).toThrow();
});
