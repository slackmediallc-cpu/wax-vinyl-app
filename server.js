const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCOGS_KEY = (process.env.DISCOGS_KEY || '').trim();
const ELEVENLABS_KEY = (process.env.ELEVENLABS_KEY || '').trim();
const CHARLOTTE_VOICE_ID = 'XB0fDUnXU5powFXDhCwa';
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
  if (!stored) return res.status(401).json({ error: 'Session expired, please login again' });
  try {
    const { username, accessToken, accessSecret } = stored;
    console.log('Fetching collection for:', username);
    console.log('Token starts with:', accessToken ? accessToken.substring(0,8) : 'NONE');
    console.log('Secret starts with:', accessSecret ? accessSecret.substring(0,8) : 'NONE');
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
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${CHARLOTTE_VOICE_ID}/stream`, {
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Wax running on port ${PORT}`));
