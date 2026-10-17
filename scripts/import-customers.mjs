import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';

const data = JSON.parse(await readFile(new URL('../sample_customers.json', import.meta.url), 'utf8'));
if (!Array.isArray(data) || data.length === 0) throw new Error('Expected a nonempty dataset array.');
const ids = new Set();
const rows = data.map((row, index) => {
  if (!row || typeof row !== 'object' || !/^[a-f0-9]{24}$/i.test(row._id)) {
    throw new Error(`Invalid _id at row ${index}.`);
  }
  if (ids.has(row._id)) throw new Error(`Duplicate _id at row ${index}.`);
  ids.add(row._id);
  const result = { ...row, _id: new mongoose.Types.ObjectId(row._id) };
  if (result.date_of_birth !== null && result.date_of_birth !== undefined) {
    const value = new Date(result.date_of_birth);
    if (Number.isNaN(value.valueOf())) throw new Error(`Invalid birth date at row ${index}.`);
    result.date_of_birth = value;
  }
  return result;
});
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const connection = mongoose.createConnection();
try {
  await connection.openUri(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const collection = connection.collection('customers');
  const result = await collection.bulkWrite(rows.map(row => ({ updateOne: {
    filter: { _id: row._id }, update: { $setOnInsert: row }, upsert: true,
  } })), { ordered: true });
  const importedCount = await collection.countDocuments({ _id: { $in: rows.map(row => row._id) } });
  const dateCount = await collection.countDocuments({ _id: { $in: rows.map(row => row._id) }, date_of_birth: { $type: 'date' } });
  console.log(JSON.stringify({ database: connection.name, collection: 'customers', sourceRecords: rows.length, inserted: result.upsertedCount, alreadyPresent: result.matchedCount, verifiedRecords: importedCount, recordsWithBsonBirthDate: dateCount }));
} catch {
  console.error('Customer import failed. Check dataset, database connectivity, and permissions. Existing records were not overwritten; rerunning safely skips existing IDs.');
  process.exitCode = 1;
} finally {
  await connection.close();
}
