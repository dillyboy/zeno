import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';

const source = JSON.parse(
  await readFile(
    new URL(
      '../../react-component-library/lib/components/DataDisplay/Table/SampleData/jira_issues.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const data = source.payload?.gridData;
if (!Array.isArray(data) || data.length === 0)
  throw new Error('Expected a nonempty dataset array.');
const ids = new Set();
const rows = data.map((row, index) => {
  if (!row || typeof row !== 'object' || !/^[a-f0-9]{24}$/i.test(row._id)) {
    throw new Error(`Invalid _id at row ${index}.`);
  }
  if (ids.has(row._id)) throw new Error(`Duplicate _id at row ${index}.`);
  ids.add(row._id);
  const result = { ...row, _id: new mongoose.Types.ObjectId(row._id) };
  for (const field of ['created', 'updated']) {
    if (result[field] === null || result[field] === undefined) continue;
    const value = new Date(result[field]);
    if (Number.isNaN(value.valueOf())) throw new Error(`Invalid ${field} date at row ${index}.`);
    result[field] = value;
  }
  return result;
});
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const connection = mongoose.createConnection();
try {
  await connection.openUri(process.env.MONGODB_URI, {
    dbName: 'server_grid',
    serverSelectionTimeoutMS: 10000,
  });
  const collection = connection.collection('jira_issues');
  // Explicit replacement is for disposable test data; default imports still skip existing IDs.
  if (process.argv.includes('--replace')) await collection.deleteMany({});
  const result = await collection.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $setOnInsert: row },
        upsert: true,
      },
    })),
    { ordered: true },
  );
  const importedCount = await collection.countDocuments({
    _id: { $in: rows.map((row) => row._id) },
  });
  const dateCount = await collection.countDocuments({
    _id: { $in: rows.map((row) => row._id) },
    created: { $type: 'date' },
    updated: { $type: 'date' },
  });
  if (importedCount !== rows.length || dateCount !== rows.length) {
    throw new Error('Import verification failed.');
  }
  console.log(
    JSON.stringify({
      database: connection.name,
      collection: 'jira_issues',
      sourceRecords: rows.length,
      inserted: result.upsertedCount,
      alreadyPresent: result.matchedCount,
      verifiedRecords: importedCount,
      recordsWithBsonDates: dateCount,
      issueTypes: await collection.distinct('issue_type'),
      priorities: await collection.distinct('priority'),
    }),
  );
} catch {
  console.error(
    'Jira issue import failed. Check dataset, database connectivity, and permissions. Default imports skip existing IDs; --replace clears the collection before importing.',
  );
  process.exitCode = 1;
} finally {
  await connection.close();
}
