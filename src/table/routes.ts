import type { FastifyInstance } from 'fastify';
import { authenticateCookie } from '../auth/authenticate.ts';
import { compileTableQuery, TableQueryError, type TableFields } from './query.ts';

export interface TableResource {
  url: string;
  collection: string;
  fields: TableFields;
  tag: string;
  requireAuth?: boolean;
}

/** Register a trusted collection. Collection names and MongoDB paths never come from requests. */
export function registerTableSearch(app: FastifyInstance, resource: TableResource) {
  app.post(
    resource.url,
    {
      bodyLimit: 64 * 1024,
      preHandler: resource.requireAuth === false ? [] : authenticateCookie,
      schema: {
        tags: [resource.tag],
        summary: `Search ${resource.collection}`,
        security: resource.requireAuth === false ? [] : [{ cookieAuth: [] }],
        description:
          'Read-only table search. Fields: ' +
          Object.entries(resource.fields)
            .map(([name, field]) => `${name} (${field.type})`)
            .join(', '),
        // Validation runs in the compiler to reject, rather than coerce or strip, invalid input.
        body: { examples: [{ page: 1, pageSize: 100, sort: null, filters: [] }] },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const query = compileTableQuery(request.body, resource.fields);
        const collection = app.db.collection(resource.collection);
        const totalItems = await collection.countDocuments(query.match, { maxTimeMS: 10000 });
        const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
        const currentPage = Math.min(query.page, totalPages);
        const rows = await collection
          .aggregate(
            [
              { $match: query.match },
              ...query.sortStages,
              ...(query.sort
                ? [
                    {
                      $sort: {
                        blank: 1,
                        ['row.' + query.sort.field.path]: query.sort.direction,
                        'row._id': 1,
                      },
                    },
                  ]
                : []),
              { $skip: (currentPage - 1) * query.pageSize },
              { $limit: query.pageSize },
              ...(query.sort ? [{ $replaceWith: '$row' }] : []),
            ],
            { collation: { locale: 'en', strength: 1 }, maxTimeMS: 10000 },
          )
          .toArray();
        return {
          items: rows.map(({ _id, ...row }) => ({ ...row, id: row.id ?? String(_id) })),
          pagination: {
            requestedPage: query.page,
            currentPage,
            pageSize: query.pageSize,
            totalItems,
            totalPages,
          },
        };
      } catch (error) {
        if (error instanceof TableQueryError) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_TABLE_QUERY',
              message: error.message,
              details: [{ path: error.path, message: error.message }],
            },
          });
        }
        request.log.error({ err: error }, 'Table search failed');
        return reply
          .code(500)
          .send({ error: { code: 'TABLE_SEARCH_FAILED', message: 'Unable to search records.' } });
      }
    },
  );
}
