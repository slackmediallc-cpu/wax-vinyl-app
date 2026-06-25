const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initSchema } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCOGS_KEY = (process.env.DISCOGS_KEY || '').trim();
const ELEVENLABS_KEY = (process.env.ELEVENLABS_KEY || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_KEY || '').trim();
const GENIUS_KEY = (process.env.GENIUS_KEY || '').trim();
const ADAM_VOICE_ID = 'XB0fDUnXU5powFXDhCwa';
const DISCOGS_SECRET = (process.env.DISCOGS_SECRET || '').trim();
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).trim().replace(/\/$/, '');
const CALLBACK_URL = `${APP_URL}/auth/callback`;
const JWT_SECRET = (process.env.JWT_SECRET || 'wax-dev-secret-change-me').trim();

// In-memory token store (keyed by state token) - used during Discogs OAuth handshake only
const tokenStore = new Map();
// Pending Discogs OAuth linking requests, keyed by oauth state -> wax user id
const pendingDiscogsLink = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

initSchema().catch(e => console.error('Schema init failed:', e.message || e, e.stack || ''));

// ── Wax account auth (JWT-based) ──
function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '90d' });
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
}

app.post('/api/auth/signup', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not configured' });
  const { email, password, displayName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with that email already exists' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
      [email.toLowerCase().trim(), hash, displayName || email.split('@')[0]]
    );
    const user = result.rows[0];
    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name } });
  } catch (e) {
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not configured' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Incorrect email or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password' });
    const token = signToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        discogsUsername: user.discogs_username,
        discogsLinked: !!user.discogs_access_token,
      }
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Temporary no-email password reset (confirms account by email, sets new password directly).
// Note: this is intentionally permissive for early testing — anyone who knows the email
// can reset the password. Replace with a real emailed reset-link flow before public launch.
app.post('/api/auth/reset-password', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not configured' });
  const { email, newPassword } = req.body || {};
  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'No account found with that email' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    const token = signToken(user.id);
    res.json({ ok: true, token });
  } catch (e) {
    console.error('Password reset error:', e.message);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, avatar_url, discogs_username, discogs_access_token,
              username, is_public, bio, setup_description, setup_photo, storage_description, storage_photo
       FROM users WHERE id = $1`,
      [req.userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      discogsUsername: user.discogs_username,
      discogsLinked: !!user.discogs_access_token,
      username: user.username,
      isPublic: user.is_public,
      bio: user.bio,
      setupDescription: user.setup_description,
      setupPhoto: user.setup_photo,
      storageDescription: user.storage_description,
      storagePhoto: user.storage_photo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/avatar', requireAuth, async (req, res) => {
  const { avatarUrl } = req.body || {};
  if (!avatarUrl) return res.status(400).json({ error: 'No image provided' });
  try {
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function pct(str) { return encodeURIComponent(String(str)); }

function buildAuthHeader(method, url, extraParams, tokenSecret) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = {
    oauth_consumer_key: DISCOGS_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
    ...extraParams,
  };
  const paramStr = Object.keys(params).sort()
    .map(k => `${pct(k)}=${pct(params[k])}`).join('&');
  const baseString = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const signingKey = `${pct(DISCOGS_SECRET)}&${pct(tokenSecret || '')}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  return 'OAuth ' + [...Object.keys(params).sort()
    .map(k => `${pct(k)}="${pct(params[k])}"`),
    `oauth_signature="${pct(signature)}"`].join(', ');
}

// Low-level HTTPS GET returning parsed JSON. node-fetch v2 has a known bug
// where gzipped chunked responses from Discogs can trigger "Premature close"
// errors — Node's native https module sidesteps it entirely. Both the
// authenticated (OAuth) and public/unauthenticated Discogs GET calls share
// this helper so neither path can hit the bug.
function httpsGetJson(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': 'WaxVinylApp/1.0',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity', // avoid gzip stream-parsing edge cases
      }, extraHeaders || {}),
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Discogs ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Could not parse Discogs response: ' + e.message));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Discogs request timed out')));
    req.on('error', reject);
  });
}

async function discogsGet(endpoint, accessToken, accessSecret) {
  const url = `https://api.discogs.com${endpoint}`;
  const header = buildAuthHeader('GET', url, { oauth_token: accessToken }, accessSecret);
  return httpsGetJson(url, { 'Authorization': header });
}

function discogsPublicGet(url) {
  return httpsGetJson(url);
}

app.get('/auth/login', requireAuth, async (req, res) => {
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return res.status(500).send('Missing API credentials');
  try {
    const url = 'https://api.discogs.com/oauth/request_token';
    const header = buildAuthHeader('POST', url, { oauth_callback: CALLBACK_URL });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': header, 'User-Agent': 'WaxVinylApp/1.0', 'Content-Length': '0' }
    });
    const text = await response.text();
    if (!response.ok) return res.status(500).json({ error: 'Failed to get request token.', detail: text });
    const params = new URLSearchParams(text);
    const token = params.get('oauth_token');
    const secret = params.get('oauth_token_secret');
    // Store secret keyed by request token, remember which Wax user is linking
    tokenStore.set(token, { secret, created: Date.now() });
    pendingDiscogsLink.set(token, req.userId);
    res.json({ redirectUrl: `https://discogs.com/oauth/authorize?oauth_token=${token}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sync Discogs collection into the local DB ──────────────────────────────
// Fetches all pages of the user's Discogs collection and upserts each record
// into the records table (source='discogs'). Any records the user has since
// removed from Discogs get deleted from the local DB so the two stay in sync.
// Storing Discogs records locally means:
//   • The collection endpoint no longer blocks on a live Discogs API call
//   • Admin record counts are accurate (everything is in one table)
//   • A "Sync now" button works without a full OAuth re-dance
async function syncDiscogsCollection(userId, username, accessToken, accessSecret) {
  let page = 1, allReleases = [];
  while (true) {
    const data = await discogsGet(
      `/users/${username}/collection/folders/0/releases?per_page=100&page=${page}&sort=artist&sort_order=asc`,
      accessToken, accessSecret
    );
    allReleases = allReleases.concat(data.releases || []);
    if (page >= (data.pagination?.pages || 1)) break;
    page++;
  }

  // Upsert — update metadata if the record is already stored (e.g. re-sync)
  for (const r of allReleases) {
    const bi = r.basic_information;
    await pool.query(
      `INSERT INTO records
         (user_id, source, discogs_release_id, title, artist, year, genre, style, format, label, cover_image, thumb)
       VALUES ($1, 'discogs', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, discogs_release_id) DO UPDATE SET
         source = 'discogs',
         title = EXCLUDED.title, artist = EXCLUDED.artist, year = EXCLUDED.year,
         genre = EXCLUDED.genre, style = EXCLUDED.style, format = EXCLUDED.format,
         label = EXCLUDED.label, cover_image = EXCLUDED.cover_image, thumb = EXCLUDED.thumb`,
      [
        userId, String(r.id),
        bi.title,
        bi.artists?.[0]?.name || 'Unknown Artist',
        bi.year || null,
        bi.genres?.[0] || null,
        bi.styles?.[0] || null,
        bi.formats?.[0]?.name || null,
        bi.labels?.[0]?.name || null,
        bi.cover_image || null,
        bi.thumb || null,
      ]
    );
  }

  // Remove any records that are no longer in the Discogs collection
  if (allReleases.length > 0) {
    const ids = allReleases.map(r => String(r.id));
    await pool.query(
      `DELETE FROM records WHERE user_id = $1 AND source = 'discogs'
       AND discogs_release_id != ALL($2::text[])`,
      [userId, ids]
    );
  }

  return allReleases.length;
}

app.get('/auth/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  try {
    const stored = tokenStore.get(oauth_token);
    const waxUserId = pendingDiscogsLink.get(oauth_token);
    if (!stored || !waxUserId) return res.redirect('/?error=session_expired');
    tokenStore.delete(oauth_token);
    pendingDiscogsLink.delete(oauth_token);

    const url = 'https://api.discogs.com/oauth/access_token';
    const header = buildAuthHeader('POST', url, { oauth_token, oauth_verifier }, stored.secret);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': header, 'User-Agent': 'WaxVinylApp/1.0', 'Content-Length': '0' }
    });
    const text = await response.text();
    if (!response.ok) return res.redirect('/?error=auth_failed');
    const p = new URLSearchParams(text);
    const accessToken = p.get('oauth_token');
    const accessSecret = p.get('oauth_token_secret');
    const identity = await discogsGet('/oauth/identity', accessToken, accessSecret);

    // Persist Discogs link to the Wax user's account in the database
    await pool.query(
      'UPDATE users SET discogs_username = $1, discogs_access_token = $2, discogs_access_secret = $3 WHERE id = $4',
      [identity.username, accessToken, accessSecret, waxUserId]
    );

    // Sync the full Discogs collection into local DB straight away so the
    // user sees their records immediately after linking (no separate step).
    try {
      await syncDiscogsCollection(waxUserId, identity.username, accessToken, accessSecret);
    } catch(e) {
      console.error('Initial Discogs sync failed:', e.message);
      // Don't block the redirect — user can Sync Now from Settings if needed
    }

    res.redirect(`/?discogs_linked=success&user=${encodeURIComponent(identity.username)}`);
  } catch(e) {
    console.error('Callback error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/api/auth/discogs/unlink', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET discogs_username = NULL, discogs_access_token = NULL, discogs_access_secret = NULL WHERE id = $1',
      [req.userId]
    );
    // Remove synced Discogs records — manual records stay in the collection
    await pool.query("DELETE FROM records WHERE user_id = $1 AND source = 'discogs'", [req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/release/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT discogs_access_token, discogs_access_secret FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    const data = user && user.discogs_access_token
      ? await discogsGet(`/releases/${req.params.id}`, user.discogs_access_token, user.discogs_access_secret)
      : await httpsGetJson(`https://api.discogs.com/releases/${req.params.id}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: 'Failed to fetch release' }); }
});

// ── Sync Now endpoint — re-pulls Discogs collection into DB on demand ──────
app.post('/api/sync-discogs', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT discogs_username, discogs_access_token, discogs_access_secret FROM users WHERE id = $1',
      [req.userId]
    );
    const user = result.rows[0];
    if (!user || !user.discogs_access_token) {
      return res.status(400).json({ error: 'No Discogs account linked' });
    }
    const count = await syncDiscogsCollection(
      req.userId, user.discogs_username, user.discogs_access_token, user.discogs_access_secret
    );
    res.json({ ok: true, synced: count });
  } catch(e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

// ── Unified collection — served from local DB (fast, no live Discogs call) ─
app.get('/api/collection', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT discogs_username, discogs_access_token FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userResult.rows[0];

    const recordsResult = await pool.query(
      'SELECT * FROM records WHERE user_id = $1 ORDER BY artist ASC, title ASC',
      [req.userId]
    );

    const releases = recordsResult.rows.map(r => ({
      id: r.discogs_release_id || `manual-${r.id}`,
      manual_db_id: r.source === 'manual' ? r.id : null,
      basic_information: {
        id: r.discogs_release_id || null,
        title: r.title,
        artists: [{ name: r.artist || 'Unknown Artist' }],
        year: r.year,
        genres:   r.genre  ? [r.genre]           : [],
        styles:   r.style  ? [r.style]            : [],
        formats:  r.format ? [{ name: r.format }] : [],
        labels:   r.label  ? [{ name: r.label }]  : [],
        cover_image: r.cover_image,
        thumb:       r.thumb,
      }
    }));

    res.json({
      releases,
      total: releases.length,
      username:      user?.discogs_username || null,
      discogsLinked: !!(user && user.discogs_access_token),
      manualCount:   recordsResult.rows.filter(r => r.source === 'manual').length,
      discogsCount:  recordsResult.rows.filter(r => r.source === 'discogs').length,
    });
  } catch(e) {
    console.error('Collection error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Discogs' database search returns every pressing/format/reissue/remaster of an
// album as its own separate result — AND, for a bare artist-name search, every
// single, EP, compilation, and soundtrack appearance too. This does two things:
// 1) Groups results by master_id (the field Discogs uses to link all versions of
//    the same release together) so the user sees one representative entry per
//    album instead of a dozen near-duplicate pressings. Releases with no
//    master_id (singles, obscure pressings) fall back to their own id.
// 2) Ranks proper studio albums above singles/EPs/compilations/etc., and within
//    each tier sorts by how many Discogs users actually own the release
//    (community.have) — so for a query like "smashing pumpkins", well-known
//    albums like Siamese Dream surface before obscure 7" singles, without
//    hiding those singles entirely (they're still there, just lower down).
const NOISY_FORMAT_TAGS = ['single', 'ep', 'compilation', 'soundtrack', 'mixtape', 'split', 'promo'];

function dedupeReleaseResults(raw, limit) {
  const groups = new Map();
  for (const r of raw) {
    const formats = (r.format || []).map(f => f.toLowerCase());
    const isVinyl = formats.some(f => f.includes('vinyl'));
    const isAlbum = formats.includes('album');
    const isNoisy = formats.some(f => NOISY_FORMAT_TAGS.includes(f));
    const have = (r.community && r.community.have) || 0;

    // Group by normalised "artist — title" so every pressing/year of the same
    // album collapses into one result. master_id is unreliable (missing on many
    // releases), and users just want to find the album — not pick a pressing.
    const artistPart = (r.title || '').split(' - ')[0].toLowerCase().trim();
    const titlePart  = (r.title || '').split(' - ').slice(1).join(' - ').toLowerCase().trim() || artistPart;
    const key = artistPart + '|||' + titlePart;

    const existing = groups.get(key);
    // Keep the most-owned pressing as the representative so the cover art and
    // metadata shown are from whichever version Discogs collectors know best.
    if (!existing || have > existing.have) {
      groups.set(key, { r, isVinyl, isAlbum, isNoisy, have });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => {
      if (a.isAlbum !== b.isAlbum) return a.isAlbum ? -1 : 1;
      if (a.isNoisy !== b.isNoisy) return a.isNoisy ? 1 : -1;
      return b.have - a.have;
    })
    .slice(0, limit)
    .map(({ r }) => ({
      discogsId: r.id,
      title: r.title,
      year: r.year,
      genre: (r.genre || [])[0] || '',
      style: (r.style || [])[0] || '',
      format: (r.format || [])[0] || '',
      label: (r.label || [])[0] || '',
      coverImage: r.cover_image,
      thumb: r.thumb,
    }));
}

// ── Search Discogs database for a release to manually add ──
app.get('/api/search-release', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return res.status(500).json({ error: 'Search not configured' });
  try {
    // format=Vinyl tells Discogs to only return vinyl releases, eliminating CDs,
    // cassettes, MP3s etc. from the raw pool before we even see them.
    const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&format=Vinyl&key=${DISCOGS_KEY}&secret=${DISCOGS_SECRET}&per_page=100&page=${page}`;
    const data = await discogsPublicGet(url);
    const totalPages = data.pagination?.pages || 1;
    // Secondary filter: drop anything the API snuck through that isn't vinyl
    const vinylOnly = (data.results || []).filter(r =>
      (r.format || []).some(f => /vinyl/i.test(f))
    );
    const results = dedupeReleaseResults(vinylOnly, 15);
    res.json({ results, hasMore: page < totalPages });
  } catch(e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Add a manually-found record to the user's collection ──
app.post('/api/records', requireAuth, async (req, res) => {
  const { discogsId, title, artist, year, genre, style, format, label, coverImage, thumb } = req.body || {};
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist required' });
  try {
    const result = await pool.query(
      `INSERT INTO records (user_id, source, discogs_release_id, title, artist, year, genre, style, format, label, cover_image, thumb)
       VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, discogs_release_id) DO NOTHING
       RETURNING *`,
      [req.userId, discogsId ? String(discogsId) : null, title, artist, year || null, genre || null, style || null, format || null, label || null, coverImage || null, thumb || null]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Already in your collection' });
    }
    res.json({ ok: true, record: result.rows[0] });
  } catch(e) {
    console.error('Add record error:', e.message);
    res.status(500).json({ error: 'Could not add record' });
  }
});

app.delete('/api/records/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM records WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/store', (req, res) => {
  const entries = [];
  tokenStore.forEach((v, k) => {
    entries.push({ key: k.substring(0,8)+'...', username: v.username, hasToken: !!v.accessToken, age: Math.round((Date.now()-v.created)/1000)+'s' });
  });
  res.json({ storeSize: tokenStore.size, entries });
});

// Claude AI chat proxy - keeps API key server-side
app.post('/api/chat', requireAuth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'AI not configured' });

  const { messages, system, max_tokens } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages provided' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: max_tokens || 400,
        system,
        messages,
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    console.error('Claude proxy error:', e.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// ElevenLabs TTS proxy - keeps API key server-side
app.post('/api/speak', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  if (!ELEVENLABS_KEY) return res.status(500).json({ error: 'ElevenLabs not configured' });

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ADAM_VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.85,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs error:', response.status, err);
      return res.status(500).json({ error: 'TTS failed' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    response.body.pipe(res);
  } catch(e) {
    console.error('Speak error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Genius lyrics proxy - uses API search only, no scraping
app.get('/api/lyrics', requireAuth, async (req, res) => {
  if (!GENIUS_KEY) return res.status(500).json({ error: 'Genius not configured' });

  const { artist, song } = req.query;
  if (!artist || !song) return res.status(400).json({ error: 'Missing artist or song' });

  try {
    const searchUrl = 'https://api.genius.com/search?q=' + encodeURIComponent(artist + ' ' + song);
    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': 'Bearer ' + GENIUS_KEY },
      signal: AbortSignal.timeout(5000),
    });
    const searchData = await searchRes.json();
    const hits = searchData.response?.hits || [];

    if (hits.length === 0) return res.json({ lyrics: null });

    // Find best match
    const artistLower = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
    const songLower = song.toLowerCase().replace(/[^a-z0-9]/g, '');
    let best = hits[0];
    for (const hit of hits) {
      const ha = (hit.result.primary_artist?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ht = (hit.result.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if ((ha.includes(artistLower) || artistLower.includes(ha)) && ht.includes(songLower)) {
        best = hit; break;
      }
    }

    // Fetch the Genius page and scrape lyrics
    const pageRes = await fetch(best.result.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });

    const html = await pageRes.text();

    // Multiple extraction strategies
    let lyrics = '';
    const NL = String.fromCharCode(10);

    // Strategy 1: data-lyrics-container
    const containers = html.match(/data-lyrics-container="true"[\s\S]*?<\/div>/g) || [];
    if (containers.length > 0) {
      lyrics = containers.map(function(block) {
        return block
          .replace(/data-lyrics-container="true"[^>]*>/, '')
          .replace(/<br[^>]*>/gi, NL)
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&apos;/g, "'")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
      }).join(NL).trim();
    }

    // Strategy 2: JSON embedded lyrics
    if (!lyrics) {
      const jsonMatch = html.match(/"plain":"([^"]+)"/);
      if (jsonMatch) {
        try {
          lyrics = JSON.parse('"' + jsonMatch[1] + '"');
        } catch(e) {
          lyrics = jsonMatch[1].split('\\n').join(NL);
        }
      }
    }
    if (!lyrics || lyrics.length < 10) {
      return res.json({ lyrics: null, url: best.result.url, title: best.result.title });
    }

    res.json({
      lyrics,
      title: best.result.title,
      artist: best.result.primary_artist?.name || artist,
      url: best.result.url
    });
  } catch(e) {
    console.error('Genius error:', e.message);
    res.json({ lyrics: null });
  }
});

// ═════════════════════════════════════════════════════════════
// PHASE A — SOCIAL / FRIENDS
// ═════════════════════════════════════════════════════════════

// ── Username setup ────────────────────────────────────────────
app.post('/api/auth/username', requireAuth, async (req, res) => {
  let { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  username = username.toLowerCase().trim();
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2–30 chars: letters, numbers, dots, hyphens, underscores only' });
  }
  try {
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.userId]);
    res.json({ ok: true, username });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken — try another' });
    res.status(500).json({ error: e.message });
  }
});

// ── Profile text fields (bio, setup, storage descriptions) ────
app.post('/api/auth/profile', requireAuth, async (req, res) => {
  const { bio, setupDescription, storageDescription } = req.body || {};
  try {
    await pool.query(
      'UPDATE users SET bio = $1, setup_description = $2, storage_description = $3 WHERE id = $4',
      [bio || null, setupDescription || null, storageDescription || null, req.userId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Setup photo upload ────────────────────────────────────────
app.post('/api/auth/setup-photo', requireAuth, async (req, res) => {
  const { photoUrl } = req.body || {};
  if (!photoUrl) return res.status(400).json({ error: 'No image provided' });
  try {
    await pool.query('UPDATE users SET setup_photo = $1 WHERE id = $2', [photoUrl, req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Storage photo upload ──────────────────────────────────────
app.post('/api/auth/storage-photo', requireAuth, async (req, res) => {
  const { photoUrl } = req.body || {};
  if (!photoUrl) return res.status(400).json({ error: 'No image provided' });
  try {
    await pool.query('UPDATE users SET storage_photo = $1 WHERE id = $2', [photoUrl, req.userId]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Privacy toggle ────────────────────────────────────────────
app.post('/api/auth/privacy', requireAuth, async (req, res) => {
  const { isPublic } = req.body || {};
  try {
    await pool.query('UPDATE users SET is_public = $1 WHERE id = $2', [!!isPublic, req.userId]);
    // Switching to public auto-accepts all pending follow requests
    if (isPublic) {
      await pool.query(
        "UPDATE follows SET status = 'accepted' WHERE following_id = $1 AND status = 'pending'",
        [req.userId]
      );
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── User search — MUST come before /api/users/:username ───────
app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ users: [] });
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_public,
             COUNT(DISTINCT r.id) AS record_count,
             f.status AS follow_status
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      LEFT JOIN follows f ON f.follower_id = $2 AND f.following_id = u.id
      WHERE u.username ILIKE $1 AND u.id != $2 AND u.username IS NOT NULL
      GROUP BY u.id, f.status
      ORDER BY u.username
      LIMIT 20
    `, [q + '%', req.userId]);
    res.json({ users: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Follow list endpoints — MUST come before /api/follow/:userId ──
app.get('/api/follows/pending', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, f.created_at
      FROM follows f
      JOIN users u ON u.id = f.follower_id
      WHERE f.following_id = $1 AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `, [req.userId]);
    res.json({ requests: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/follows/following', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_public,
             COUNT(DISTINCT r.id) AS record_count, f.status
      FROM follows f
      JOIN users u ON u.id = f.following_id
      LEFT JOIN records r ON r.user_id = u.id
      WHERE f.follower_id = $1
      GROUP BY u.id, f.status
      ORDER BY u.username
    `, [req.userId]);
    res.json({ following: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/follows/followers', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url,
             COUNT(DISTINCT r.id) AS record_count, f.status
      FROM follows f
      JOIN users u ON u.id = f.follower_id
      LEFT JOIN records r ON r.user_id = u.id
      WHERE f.following_id = $1 AND f.status = 'accepted'
      GROUP BY u.id, f.status
      ORDER BY u.username
    `, [req.userId]);
    res.json({ followers: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Follow actions ────────────────────────────────────────────
app.post('/api/follow/:userId', requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.userId);
  if (isNaN(targetId) || targetId === req.userId) {
    return res.status(400).json({ error: 'Invalid user' });
  }
  try {
    const userResult = await pool.query('SELECT is_public FROM users WHERE id = $1', [targetId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const status = userResult.rows[0].is_public ? 'accepted' : 'pending';
    await pool.query(
      `INSERT INTO follows (follower_id, following_id, status) VALUES ($1, $2, $3)
       ON CONFLICT (follower_id, following_id) DO UPDATE SET status = EXCLUDED.status`,
      [req.userId, targetId, status]
    );
    res.json({ ok: true, status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/follow/:userId/accept', requireAuth, async (req, res) => {
  const followerId = parseInt(req.params.userId);
  try {
    await pool.query(
      "UPDATE follows SET status = 'accepted' WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'",
      [followerId, req.userId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/follow/:userId/decline', requireAuth, async (req, res) => {
  const followerId = parseInt(req.params.userId);
  try {
    await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, req.userId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/follow/:userId', requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.userId);
  try {
    await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.userId, targetId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── User profile by username ──────────────────────────────────
app.get('/api/users/:username', requireAuth, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_public,
             u.bio, u.setup_description, u.setup_photo, u.storage_description, u.storage_photo,
             COUNT(DISTINCT r.id) AS record_count,
             (SELECT COUNT(*) FROM follows WHERE following_id = u.id AND status = 'accepted') AS follower_count,
             (SELECT COUNT(*) FROM follows WHERE follower_id  = u.id AND status = 'accepted') AS following_count,
             f.status AS follow_status
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      LEFT JOIN follows f ON f.follower_id = $2 AND f.following_id = u.id
      WHERE LOWER(u.username) = $1
      GROUP BY u.id, f.status
    `, [username, req.userId]);

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = result.rows[0];
    const isSelf  = u.id === req.userId;
    const canView = isSelf || u.is_public || u.follow_status === 'accepted';

    res.json({
      id:                 u.id,
      username:           u.username,
      displayName:        u.display_name,
      avatarUrl:          u.avatar_url,
      isPublic:           u.is_public,
      bio:                u.bio,
      setupDescription:   canView ? u.setup_description  : null,
      setupPhoto:         canView ? u.setup_photo         : null,
      storageDescription: canView ? u.storage_description : null,
      storagePhoto:       canView ? u.storage_photo       : null,
      recordCount:        parseInt(u.record_count)   || 0,
      followerCount:      parseInt(u.follower_count)  || 0,
      followingCount:     parseInt(u.following_count) || 0,
      followStatus:       isSelf ? 'self' : (u.follow_status || 'none'),
      isSelf,
      canView,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Friend's collection (permission-checked) ──────────────────
app.get('/api/users/:username/collection', requireAuth, async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    const userResult = await pool.query(
      'SELECT id, is_public FROM users WHERE LOWER(username) = $1', [username]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const target  = userResult.rows[0];
    const isSelf  = target.id === req.userId;

    if (!isSelf && !target.is_public) {
      const fResult = await pool.query(
        "SELECT status FROM follows WHERE follower_id = $1 AND following_id = $2",
        [req.userId, target.id]
      );
      if (!fResult.rows[0] || fResult.rows[0].status !== 'accepted') {
        return res.status(403).json({ error: 'private_collection' });
      }
    }

    const recordsResult = await pool.query(
      'SELECT * FROM records WHERE user_id = $1 ORDER BY artist ASC, title ASC',
      [target.id]
    );

    const releases = recordsResult.rows.map(r => ({
      id:           r.discogs_release_id || `manual-${r.id}`,
      manual_db_id: (isSelf && r.source === 'manual') ? r.id : null,
      basic_information: {
        id:          r.discogs_release_id || null,
        title:       r.title,
        artists:     [{ name: r.artist || 'Unknown Artist' }],
        year:        r.year,
        genres:      r.genre  ? [r.genre]           : [],
        styles:      r.style  ? [r.style]            : [],
        formats:     r.format ? [{ name: r.format }] : [],
        labels:      r.label  ? [{ name: r.label }]  : [],
        cover_image: r.cover_image,
        thumb:       r.thumb,
      }
    }));

    res.json({ releases, total: releases.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Record owners / discovery ─────────────────────────────────
// Returns other Wax users who own this release, sorted by how many
// records they share with the requesting user — so "most in common"
// floats to the top. Works for both public and private accounts
// (username + common count shown either way, collection gated separately).
app.get('/api/records/:releaseId/owners', requireAuth, async (req, res) => {
  const releaseId = req.params.releaseId;
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_public,
             f.status AS follow_status,
             (
               SELECT COUNT(*) FROM records r2
               WHERE r2.user_id = u.id
               AND r2.discogs_release_id IN (
                 SELECT discogs_release_id FROM records
                 WHERE user_id = $2 AND discogs_release_id IS NOT NULL
               )
             ) AS common_count
      FROM records r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN follows f ON f.follower_id = $2 AND f.following_id = u.id
      WHERE r.discogs_release_id = $1
        AND r.user_id != $2
        AND u.username IS NOT NULL
      GROUP BY u.id, f.status
      ORDER BY common_count DESC, u.username
    `, [releaseId, req.userId]);
    res.json({ owners: result.rows, total: result.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN DASHBOARD
// Protected by ADMIN_PASSWORD env var + a signed JWT cookie.
// Route: /admin  (never linked from the app UI)
// ─────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_COOKIE   = 'wax_admin';

function adminAuth(req, res, next) {
  try {
    const token = req.cookies?.[ADMIN_COOKIE] || '';
    jwt.verify(token, JWT_SECRET + '_admin');
    next();
  } catch {
    res.redirect('/admin/login');
  }
}

// Minimal cookie parser (no extra dep needed)
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

function adminHtml(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wax Admin — ${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#e0d5c5;min-height:100vh}
  a{color:#c4922a;text-decoration:none} a:hover{text-decoration:underline}
  .topbar{background:#1a1610;border-bottom:1px solid #2a2218;padding:14px 28px;display:flex;align-items:center;gap:20px}
  .topbar h1{font-size:18px;font-weight:700;color:#c4922a}
  .topbar nav{display:flex;gap:16px;font-size:13px}
  .content{padding:28px;max-width:1100px;margin:0 auto}
  .card{background:#1a1610;border:1px solid #2a2218;border-radius:10px;padding:20px;margin-bottom:20px}
  .stat-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#1a1610;border:1px solid #2a2218;border-radius:10px;padding:16px 22px;min-width:130px}
  .stat-num{font-size:28px;font-weight:700;color:#c4922a}
  .stat-lbl{font-size:12px;color:#8a7a6a;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:#8a7a6a;font-weight:600;padding:8px 12px;border-bottom:1px solid #2a2218;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td{padding:10px 12px;border-bottom:1px solid #1e1a14;vertical-align:middle}
  tr:hover td{background:#1e1a14}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:#2a1f0a;color:#c4922a;border:1px solid #c4922a}
  .badge.grey{background:#1e1e1e;color:#8a7a6a;border-color:#3a3a3a}
  .pill{display:inline-block;background:#c4922a;color:#0d0d0d;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px}
  .logout{margin-left:auto;font-size:13px;color:#8a7a6a}
  .art{width:38px;height:38px;border-radius:5px;object-fit:cover;background:#2a2218;vertical-align:middle}
  .section-title{font-size:13px;font-weight:700;color:#8a7a6a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
  input,button{font-family:inherit}
</style></head><body>
<div class="topbar">
  <h1>🎵 Wax Admin</h1>
  <nav><a href="/admin">Dashboard</a><a href="/admin/users">Users</a></nav>
  <span class="logout"><a href="/admin/logout">Log out</a></span>
</div>
<div class="content">${body}</div>
</body></html>`;
}

// ── Login page ──
app.get('/admin/login', (req, res) => {
  const err = req.query.err ? '<p style="color:#c0504a;font-size:13px;margin-top:10px;">Incorrect password.</p>' : '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Wax Admin Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#e0d5c5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#1a1610;border:1px solid #2a2218;border-radius:12px;padding:36px;width:320px}
h2{font-size:20px;font-weight:700;color:#c4922a;margin-bottom:24px}
input{width:100%;background:#0d0d0d;border:1px solid #2a2218;border-radius:7px;padding:11px 14px;color:#e0d5c5;font-size:14px;margin-bottom:14px}
button{width:100%;background:#c4922a;border:none;border-radius:7px;padding:12px;color:#0d0d0d;font-weight:700;font-size:14px;cursor:pointer}</style></head>
<body><div class="box"><h2>Wax Admin</h2>
<form method="POST" action="/admin/login">
<input type="password" name="password" placeholder="Admin password" autofocus>
<button type="submit">Log in</button>${err}
</form></div></body></html>`);
});

app.use(express.urlencoded({ extended: false }));

app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.redirect('/admin/login?err=1');
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET + '_admin', { expiresIn: '12h' });
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect('/admin/login');
});

// ── Dashboard (stats overview) ──
app.get('/admin', adminAuth, async (req, res) => {
  try {
    const [usersR, recordsR, newUsersR, topAlbumsR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM records'),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'"),
      pool.query(`SELECT title, artist, COUNT(*) as owners
                  FROM records GROUP BY title, artist
                  ORDER BY owners DESC LIMIT 10`),
    ]);

    const totalUsers   = usersR.rows[0].count;
    const totalRecords = recordsR.rows[0].count;
    const newUsers     = newUsersR.rows[0].count;
    const topAlbums    = topAlbumsR.rows;

    const topAlbumRows = topAlbums.map((r, i) =>
      `<tr><td style="color:#8a7a6a;width:28px">${i+1}</td>
       <td><strong>${escAdmin(r.title)}</strong><br><span style="color:#8a7a6a;font-size:12px">${escAdmin(r.artist)}</span></td>
       <td><span class="pill">${r.owners} ${r.owners == 1 ? 'owner' : 'owners'}</span></td></tr>`
    ).join('');

    res.send(adminHtml('Dashboard', `
      <h2 style="font-size:22px;font-weight:700;margin-bottom:20px">Dashboard</h2>
      <div class="stat-row">
        <div class="stat"><div class="stat-num">${totalUsers}</div><div class="stat-lbl">Total users</div></div>
        <div class="stat"><div class="stat-num">${newUsers}</div><div class="stat-lbl">New this week</div></div>
        <div class="stat"><div class="stat-num">${totalRecords}</div><div class="stat-lbl">Total records</div></div>
      </div>
      <div class="card">
        <div class="section-title">Most collected albums on Wax</div>
        <table><thead><tr><th>#</th><th>Album</th><th>Collectors</th></tr></thead>
        <tbody>${topAlbumRows || '<tr><td colspan="3" style="color:#8a7a6a;padding:20px 12px">Not enough data yet</td></tr>'}</tbody></table>
      </div>
      <p style="text-align:right;margin-top:8px"><a href="/admin/users">View all users →</a></p>
    `));
  } catch(e) {
    res.status(500).send('DB error: ' + e.message);
  }
});

// ── User list ──
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.display_name, u.discogs_username,
             u.created_at,
             COUNT(r.id) AS record_count,
             COUNT(r.id) FILTER (WHERE r.source = 'manual')  AS manual_count,
             COUNT(r.id) FILTER (WHERE r.source = 'discogs') AS discogs_count
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC`);

    const rows = result.rows.map(u => {
      const joined = new Date(u.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      const discogs = u.discogs_username
        ? `<span class="badge">Discogs: ${escAdmin(u.discogs_username)}</span>`
        : `<span class="badge grey">No Discogs</span>`;
      const countDetail = u.discogs_username
        ? `${u.record_count} <span style="color:#8a7a6a;font-size:11px">(${u.discogs_count} Discogs · ${u.manual_count} manual)</span>`
        : `${u.record_count}`;
      return `<tr>
        <td><a href="/admin/users/${u.id}">${escAdmin(u.display_name || u.email)}</a>
            <br><span style="font-size:11px;color:#8a7a6a">${escAdmin(u.email)}</span></td>
        <td>${discogs}</td>
        <td style="text-align:center"><strong>${countDetail}</strong></td>
        <td style="color:#8a7a6a">${joined}</td>
        <td><a href="/admin/users/${u.id}" style="font-size:12px">View →</a></td>
      </tr>`;
    }).join('');

    res.send(adminHtml('Users', `
      <h2 style="font-size:22px;font-weight:700;margin-bottom:20px">Users <span style="color:#8a7a6a;font-size:16px;font-weight:400">(${result.rows.length})</span></h2>
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>User</th><th>Discogs</th><th style="text-align:center">Records</th><th>Joined</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" style="color:#8a7a6a;padding:20px 12px">No users yet</td></tr>'}</tbody>
        </table>
      </div>
    `));
  } catch(e) {
    res.status(500).send('DB error: ' + e.message);
  }
});

// ── Per-user collection view ──
app.get('/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [userR, recordsR] = await Promise.all([
      pool.query('SELECT id, email, display_name, discogs_username, created_at FROM users WHERE id = $1', [userId]),
      pool.query('SELECT * FROM records WHERE user_id = $1 ORDER BY artist ASC, title ASC', [userId]),
    ]);
    const user = userR.rows[0];
    if (!user) return res.status(404).send('User not found');

    const joined = new Date(user.created_at).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
    const records = recordsR.rows;

    const recordRows = records.map(r => {
      const img = r.cover_image || r.thumb || '';
      return `<tr>
        <td>${img ? `<img class="art" src="${escAdmin(img)}" alt="">` : '<div class="art"></div>'}</td>
        <td><strong>${escAdmin(r.title)}</strong></td>
        <td style="color:#8a7a6a">${escAdmin(r.artist || '')}</td>
        <td style="color:#8a7a6a">${r.year || '—'}</td>
        <td style="color:#8a7a6a">${escAdmin(r.genre || '')}</td>
        <td><span class="badge ${r.source === 'manual' ? '' : 'grey'}">${r.source === 'manual' ? 'Manual' : 'Discogs'}</span></td>
      </tr>`;
    }).join('');

    res.send(adminHtml(user.display_name || user.email, `
      <p style="margin-bottom:20px"><a href="/admin/users">← All users</a></p>
      <div class="card" style="margin-bottom:20px">
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <div><div class="section-title" style="margin-bottom:6px">Name</div>${escAdmin(user.display_name || '—')}</div>
          <div><div class="section-title" style="margin-bottom:6px">Email</div>${escAdmin(user.email)}</div>
          <div><div class="section-title" style="margin-bottom:6px">Discogs</div>${user.discogs_username ? escAdmin(user.discogs_username) : '—'}</div>
          <div><div class="section-title" style="margin-bottom:6px">Joined</div>${joined}</div>
          <div><div class="section-title" style="margin-bottom:6px">Records</div><strong>${records.length}</strong></div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th></th><th>Title</th><th>Artist</th><th>Year</th><th>Genre</th><th>Source</th></tr></thead>
          <tbody>${recordRows || '<tr><td colspan="6" style="color:#8a7a6a;padding:20px 12px">No records yet</td></tr>'}</tbody>
        </table>
      </div>
    `));
  } catch(e) {
    res.status(500).send('DB error: ' + e.message);
  }
});

function escAdmin(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Wax running on port ${PORT}`));
