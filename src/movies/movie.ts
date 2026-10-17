import { Schema, type Connection, type Model } from 'mongoose';

interface Movie {
  title: string;
  year?: number | string;
  plot?: string;
  poster?: string;
  genres?: string[];
  runtime?: number;
  imdb?: { rating?: number; votes?: number; id?: number };
}

const movieSchema = new Schema<Movie>(
  {
    title: String,
    year: Schema.Types.Mixed,
    plot: String,
    poster: String,
    genres: [String],
    runtime: Number,
    imdb: { rating: Number, votes: Number, id: Number },
  },
  { collection: 'movies', autoCreate: false, autoIndex: false },
);

export function findTopMovies(connection: Connection) {
  const db = connection.useDb('sample_mflix', { useCache: true });
  const Movie =
    (db.models.Movie as Model<Movie> | undefined) ?? db.model<Movie>('Movie', movieSchema);
  return Movie.find({ 'imdb.rating': { $gte: 0, $lte: 10 } })
    .sort({ 'imdb.rating': -1, 'imdb.votes': -1, _id: 1 })
    .limit(100)
    .select('_id title year plot poster genres runtime imdb')
    .lean()
    .exec();
}
