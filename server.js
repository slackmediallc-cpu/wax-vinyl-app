const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

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

// In-memory token store (keyed by state token)
const tokenStore = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/auth/login', async (req, res) => {
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
    // Store secret keyed by request token
    tokenStore.set(token, { secret, created: Date.now() });
    res.redirect(`https://discogs.com/oauth/authorize?oauth_token=${token}`);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  try {
    const stored = tokenStore.get(oauth_token);
    if (!stored) return res.redirect('/?error=session_expired');
    tokenStore.delete(oauth_token);

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

    // Store in tokenStore by a new session key
    const sessionKey = crypto.randomBytes(32).toString('hex');
    tokenStore.set(sessionKey, {
      accessToken,
      accessSecret,
      username: identity.username,
      avatar: identity.avatar_url,
      created: Date.now()
    });

    // Pass session key via URL, frontend stores in localStorage
    res.redirect(`/?auth=success&sk=${sessionKey}&user=${encodeURIComponent(identity.username)}`);
  } catch(e) {
    console.error('Callback error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.json({ authenticated: false });
  const stored = tokenStore.get(sk);
  if (!stored) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: stored.username, avatar: stored.avatar });
});

app.get('/auth/logout', (req, res) => {
  const sk = req.query.sk;
  if (sk) tokenStore.delete(sk);
  res.json({ success: true });
});

app.get('/api/collection', async (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.status(401).json({ error: 'Not authenticated' });
  const stored = tokenStore.get(sk);
  if (!stored) return res.status(401).json({ error: 'Session expired' });
  try {
    const { username, accessToken, accessSecret } = stored;
    let page = 1, all = [];
    while (true) {
      const data = await discogsGet(
        `/users/${username}/collection/folders/0/releases?per_page=100&page=${page}&sort=artist&sort_order=asc`,
        accessToken, accessSecret
      );
      all = all.concat(data.releases || []);
      if (page >= (data.pagination?.pages || 1)) break;
      page++;
    }
    res.json({ releases: all, total: all.length, username });
  } catch(e) {
    console.error('Collection error:', e.message);
    if (e.message && e.message.includes('403')) {
      return res.status(403).json({ error: 'private_collection' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/release/:id', async (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.status(401).json({ error: 'Not authenticated' });
  const stored = tokenStore.get(sk);
  if (!stored) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await discogsGet(`/releases/${req.params.id}`, stored.accessToken, stored.accessSecret);
    res.json(data);
  } catch(e) { res.status(500).json({ error: 'Failed to fetch release' }); }
});

app.get('/debug/store', (req, res) => {
  const entries = [];
  tokenStore.forEach((v, k) => {
    entries.push({ key: k.substring(0,8)+'...', username: v.username, hasToken: !!v.accessToken, age: Math.round((Date.now()-v.created)/1000)+'s' });
  });
  res.json({ storeSize: tokenStore.size, entries });
});

// Claude AI chat proxy - keeps API key server-side
app.post('/api/chat', async (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.status(401).json({ error: 'Not authenticated' });
  const stored = tokenStore.get(sk);
  if (!stored) return res.status(401).json({ error: 'Session expired' });
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
app.post('/api/speak', async (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.status(401).json({ error: 'Not authenticated' });
  const stored = tokenStore.get(sk);
  if (!stored) return res.status(401).json({ error: 'Session expired' });

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
app.get('/api/lyrics', async (req, res) => {
  const sk = req.query.sk;
  if (!sk) return res.status(401).json({ error: 'Not authenticated' });
  const stored = tokenStore.get(sk);
  if (!stored) return res.status(401).json({ error: 'Session expired' });
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
