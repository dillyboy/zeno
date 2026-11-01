import type { FastifyInstance } from 'fastify';
import { registerTableSearch } from '../table/routes.ts';
import type { TableFields } from '../table/query.ts';

export const jiraIssueFields = {
  id: { path: 'id', type: 'number' },
  key: { path: 'key', type: 'string' },
  summary: { path: 'summary', type: 'string' },
  issue_type: {
    path: 'issue_type',
    type: 'options',
    options: ['Improvement', 'Task', 'Sub-task', 'New Feature', 'Bug', 'Epic', 'Story'],
  },
  priority: {
    path: 'priority',
    type: 'options',
    options: [
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
  },
  assignee: { path: 'assignee', type: 'string' },
  story_points: { path: 'story_points', type: 'number' },
  status: {
    path: 'status',
    type: 'options',
    options: ['To Do', 'In Progress', 'In Review', 'Done'],
  },
  sprint: { path: 'sprint', type: 'string' },
  created: { path: 'created', type: 'date' },
  updated: { path: 'updated', type: 'date' },
} satisfies TableFields;

export function registerJiraIssueRoutes(app: FastifyInstance) {
  registerTableSearch(app, {
    url: '/api/jira_issues/search',
    collection: 'jira_issues',
    fields: jiraIssueFields,
    tag: 'Jira Issues',
  });
}
