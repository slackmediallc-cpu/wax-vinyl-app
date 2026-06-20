const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
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
app.use(express.static(path.join(__dirname, 'public')));

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
    const result = await pool.query('SELECT id, email, display_name, avatar_url, discogs_username, discogs_access_token FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      discogsUsername: user.discogs_username,
      discogsLinked: !!user.discogs_access_token,
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

async function discogsGet(endpoint, accessToken, accessSecret) {
  const url = `https://api.discogs.com${endpoint}`;
  const header = buildAuthHeader('GET', url, { oauth_token: accessToken }, accessSecret);
  const res = await fetch(url, {
    headers: { 'Authorization': header, 'User-Agent': 'WaxVinylApp/1.0' }
  });
  if (!res.ok) throw new Error(`Discogs ${res.status}: ${await res.text()}`);
  return res.json();
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
      : await fetch(`https://api.discogs.com/releases/${req.params.id}`, { headers: { 'User-Agent': 'WaxVinylApp/1.0' } }).then(r => r.json());
    res.json(data);
  } catch(e) { res.status(500).json({ error: 'Failed to fetch release' }); }
});

// ── Unified collection: Discogs-synced + manually-added records, deduped ──
app.get('/api/collection', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT discogs_username, discogs_access_token, discogs_access_secret FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];

    let discogsReleases = [];
    if (user && user.discogs_access_token) {
      try {
        let page = 1;
        while (true) {
          const data = await discogsGet(
            `/users/${user.discogs_username}/collection/folders/0/releases?per_page=100&page=${page}&sort=artist&sort_order=asc`,
            user.discogs_access_token, user.discogs_access_secret
          );
          discogsReleases = discogsReleases.concat(data.releases || []);
          if (page >= (data.pagination?.pages || 1)) break;
          page++;
        }
      } catch(e) {
        if (e.message && e.message.includes('403')) {
          return res.status(403).json({ error: 'private_collection', username: user.discogs_username });
        }
        console.error('Discogs sync error:', e.message);
      }
    }

    const manualResult = await pool.query(
      "SELECT * FROM records WHERE user_id = $1 AND source = 'manual' ORDER BY added_at DESC",
      [req.userId]
    );

    const discogsIds = new Set(discogsReleases.map(r => String(r.id)));

    const manualAsReleases = manualResult.rows
      .filter(r => !r.discogs_release_id || !discogsIds.has(String(r.discogs_release_id)))
      .map(r => ({
        id: r.discogs_release_id || `manual-${r.id}`,
        manual_db_id: r.id,
        basic_information: {
          id: r.discogs_release_id || null,
          title: r.title,
          artists: [{ name: r.artist }],
          year: r.year,
          genres: r.genre ? [r.genre] : [],
          styles: r.style ? [r.style] : [],
          formats: r.format ? [{ name: r.format }] : [],
          labels: r.label ? [{ name: r.label }] : [],
          cover_image: r.cover_image,
          thumb: r.thumb,
        }
      }));

    const all = [...discogsReleases, ...manualAsReleases];
    res.json({
      releases: all,
      total: all.length,
      username: user?.discogs_username || null,
      discogsLinked: !!(user && user.discogs_access_token),
      manualCount: manualAsReleases.length,
      discogsCount: discogsReleases.length,
    });
  } catch(e) {
    console.error('Collection error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Search Discogs database for a release to manually add ──
app.get('/api/search-release', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return res.status(500).json({ error: 'Search not configured' });
  try {
    const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&key=${DISCOGS_KEY}&secret=${DISCOGS_SECRET}&per_page=20`;
    const response = await fetch(url, { headers: { 'User-Agent': 'WaxVinylApp/1.0' } });
    const data = await response.json();
    const results = (data.results || []).map(r => ({
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
    res.json({ results });
  } catch(e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Barcode lookup via Discogs database search ──
app.get('/api/barcode-lookup', requireAuth, async (req, res) => {
  const barcode = (req.query.code || '').trim();
  if (!barcode) return res.status(400).json({ error: 'Missing barcode' });
  if (!DISCOGS_KEY || !DISCOGS_SECRET) return res.status(500).json({ error: 'Search not configured' });
  try {
    const url = `https://api.discogs.com/database/search?barcode=${encodeURIComponent(barcode)}&type=release&key=${DISCOGS_KEY}&secret=${DISCOGS_SECRET}&per_page=10`;
    const response = await fetch(url, { headers: { 'User-Agent': 'WaxVinylApp/1.0' } });
    const data = await response.json();
    const results = (data.results || []).map(r => ({
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
    res.json({ results });
  } catch(e) {
    console.error('Barcode lookup error:', e.message);
    res.status(500).json({ error: 'Lookup failed' });
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Wax running on port ${PORT}`));
