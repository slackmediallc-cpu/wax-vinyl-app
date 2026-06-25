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

  // ── Core tables ───────────────────────────────────────────────────────────
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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);`);

  // ── Phase A: social columns on users (safe to run on existing DB) ─────────
  const socialCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_description TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_photo TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_description TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_photo TEXT`,
  ];
  for (const sql of socialCols) {
    await pool.query(sql);
  }

  // ── Phase A: follows table ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      id SERIAL PRIMARY KEY,
      follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(follower_id, following_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);`);

  console.log('Database schema ready.');
}
module.exports = { pool, initSchema };
