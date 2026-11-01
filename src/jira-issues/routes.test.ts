import { expect, it, vi } from 'vite-plus/test';
import { Types } from 'mongoose';
import { buildApp } from '../app.ts';
import { hasActiveSession } from '../auth/session.ts';

vi.mock('../auth/session.ts', () => ({ hasActiveSession: vi.fn() }));

it('requires authentication, clamps empty pages, preserves stored fields, and shares count filters', async () => {
  const app = await buildApp({}, 'test-secret-with-at-least-32-bytes-long');
  const toArray = vi.fn().mockResolvedValue([]);
  const aggregate = vi.fn().mockReturnValue({ toArray });
  const countDocuments = vi.fn().mockResolvedValue(0);
  const collection = vi.fn().mockReturnValue({ countDocuments, aggregate });
  app.decorate('db', { collection } as never);
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/api/jira_issues/search', payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(collection).not.toHaveBeenCalled();
    vi.mocked(hasActiveSession).mockResolvedValue(true);
    const token = app.jwt.sign({ sub: 'id', email: 'user@example.com', token_use: 'access' });
    const search = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/jira_issues/search',
        headers: { cookie: `access_token=${token}` },
        payload: payload as object,
      });
    const empty = await search({ page: 7 });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      items: [],
      pagination: { requestedPage: 7, currentPage: 1, pageSize: 100, totalItems: 0, totalPages: 1 },
    });
    expect(
      aggregate.mock.lastCall![0].some((stage: Record<string, unknown>) => '$sort' in stage),
    ).toBe(false);
    const issues = await search({
      page: 1,
      pageSize: 100,
      filters: [{ operator: 'contains', value: 'keyboard', field: 'summary' }],
      sort: null,
      timeZone: 'Asia/Singapore',
    });
    expect(issues.statusCode).toBe(200);
    expect(aggregate.mock.lastCall![0][0].$match.$and[0].$and[1]).toEqual({
      summary: { $regex: 'keyboard', $options: 'i' },
    });
    const selectedIssues = await search({
      page: 1,
      pageSize: 100,
      filters: [{ operator: 'eq', value: ['Story'], field: 'issue_type' }],
      sort: null,
      timeZone: 'Asia/Singapore',
    });
    expect(selectedIssues.statusCode).toBe(200);
    expect(aggregate.mock.lastCall![0][0].$match.$and[0].$and[1]).toEqual({
      $or: [{ issue_type: { $regex: '^Story(?![\\s\\S])', $options: 'i' } }],
    });
    for (const [field, value] of [
      ['issue_type', ['Improvement', 'Task', 'Sub-task', 'New Feature', 'Bug', 'Epic', 'Story']],
      [
        'priority',
        [
          'Blocker',
          'Critical',
          'Major',
          'Highest',
          'High',
          'Medium',
          'Low',
          'Lowest',
          'Minor',
          'Trivial',
        ],
      ],
      ['status', ['In Progress', 'Done']],
    ]) {
      expect((await search({ filters: [{ field, operator: 'eq', value }] })).statusCode).toBe(200);
    }
    expect(
      (
        await search({
          filters: [{ field: 'issue_type', operator: 'eq', value: ['Unknown'] }],
        })
      ).statusCode,
    ).toBe(400);
    const storyPoints = await search({
      page: 1,
      pageSize: 100,
      filters: [{ operator: 'eq', value: ['5'], field: 'story_points' }],
      sort: null,
      timeZone: 'Asia/Singapore',
    });
    expect(storyPoints.statusCode).toBe(200);
    expect(aggregate.mock.lastCall![0][0].$match.$and[0]).toEqual({
      $and: [{ story_points: { $type: 'number' } }, { story_points: { $in: [5] } }],
    });
    expect((await search({ page: '1' })).statusCode).toBe(400);
    expect(
      (await search({ filters: [{ field: 'email', operator: 'contains', value: 'a' }] }))
        .statusCode,
    ).toBe(400);
    for (const field of ['created', 'updated']) {
      const dated = await search({
        filters: [{ field, operator: 'in', value: ['2026-10-14'] }],
        timeZone: 'Asia/Singapore',
      });
      expect(dated.statusCode).toBe(200);
      expect(aggregate.mock.lastCall![0][0].$match).toEqual(countDocuments.mock.lastCall![0]);
    }
    const id = new Types.ObjectId();
    countDocuments.mockResolvedValue(101);
    toArray.mockResolvedValue([
      { _id: id, id: 11, name: 'Alice', custom: 'retained', __tableBlank: 'stored' },
    ]);
    const response = await search({
      page: 9,
      pageSize: 50,
      sort: { column: 'summary', direction: 'descending' },
      filters: [{ field: 'story_points', operator: 'equal', value: 0 }],
    });
    expect(response.json().pagination.currentPage).toBe(3);
    expect(response.json().items[0]).toEqual({
      id: 11,
      name: 'Alice',
      custom: 'retained',
      __tableBlank: 'stored',
    });
    const pipeline = aggregate.mock.lastCall![0];
    expect(pipeline[0].$match).toEqual(countDocuments.mock.lastCall![0]);
    expect(pipeline).toContainEqual({ $skip: 100 });
    expect(collection).toHaveBeenCalledWith('jira_issues');
    for (const direction of ['ascending', 'descending']) {
      const sorted = await search({ sort: { column: 'id', direction } });
      expect(sorted.statusCode).toBe(200);
      expect(aggregate.mock.lastCall![0]).toContainEqual({
        $sort: { blank: 1, 'row.id': direction === 'ascending' ? 1 : -1, 'row._id': 1 },
      });
    }
    vi.mocked(hasActiveSession).mockResolvedValue(false);
    expect((await search({})).statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
