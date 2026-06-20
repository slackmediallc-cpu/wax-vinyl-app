const { Pool } = require('pg');

const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });
}

async function initSchema() {
  if (!pool) {
    console.warn('No DATABASE_URL set — database features disabled.');
    return;
  }

  try {
    const test = await pool.query('SELECT NOW()');
    console.log('Database connected OK:', test.rows[0].now);
  } catch (e) {
    console.error('Database connection test FAILED:', e.message, e.stack);
    throw e;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      discogs_username TEXT,
      discogs_access_token TEXT,
      discogs_access_secret TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'manual',
      discogs_release_id TEXT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      year TEXT,
      genre TEXT,
      style TEXT,
      format TEXT,
      label TEXT,
      cover_image TEXT,
      thumb TEXT,
      added_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, discogs_release_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);
  `);

  console.log('Database schema ready.');
}

module.exports = { pool, initSchema };
