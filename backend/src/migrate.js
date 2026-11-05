import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');
const pool = new Pool({ connectionString: databaseUrl });
const migrationsPath = fileURLToPath(new URL('../db/migrations/', import.meta.url));
try {
  const files = (await readdir(migrationsPath)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsPath, file), 'utf8');
    await pool.query(sql);
    console.log(`Applied ${file}.`);
  }
} finally {
  await pool.end();
}
