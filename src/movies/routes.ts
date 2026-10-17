import type { FastifyInstance } from 'fastify';
import { authenticateCookie } from '../auth/authenticate.ts';
import { findTopMovies } from './movie.ts';

export function registerMovieRoutes(app: FastifyInstance) {
  app.get(
    '/movies/top',
    {
      preHandler: authenticateCookie,
      schema: {
        tags: ['Movies'],
        summary: 'Get the top 100 movies by IMDb rating',
        description:
          'Requires the access_token cookie from login. Ties are sorted by IMDb votes, then movie ID. Movies without a numeric rating are excluded.',
        security: [{ cookieAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['movies'],
            properties: {
              movies: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  properties: {
                    _id: { type: 'string' },
                    title: { type: 'string' },
                    year: { type: 'string' },
                    plot: { type: 'string' },
                    poster: { type: 'string' },
                    runtime: { type: 'number' },
                    genres: { type: 'array', items: { type: 'string' } },
                    imdb: {
                      type: 'object',
                      properties: {
                        rating: { type: 'number' },
                        votes: { type: 'number' },
                        id: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { type: 'object', properties: { message: { type: 'string' } } },
        },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { movies: await findTopMovies(app.db) };
    },
  );
}
