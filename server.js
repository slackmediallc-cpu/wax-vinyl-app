const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCOGS_KEY = (process.env.DISCOGS_KEY || '').trim();
const DISCOGS_SECRET = (process.env.DISCOGS_SECRET || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || 'wax-secret').trim();
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).trim().replace(/\/$/, '');
const CALLBACK_URL = `${APP_URL}/auth/callback`;

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: false }
}));
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
    req.session.oauthSecret = secret;
    req.session.save(() => res.redirect(`https://discogs.com/oauth/authorize?oauth_token=${token}`));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  try {
    const url = 'https://api.discogs.com/oauth/access_token';
    const header = buildAuthHeader('POST', url, { oauth_token, oauth_verifier }, req.session.oauthSecret);
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
    req.session.accessToken = accessToken;
    req.session.accessSecret = accessSecret;
    req.session.username = identity.username;
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/?auth=success');
    });
  } catch(e) {
    console.error('Callback error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json(req.session.username
    ? { authenticated: true, username: req.session.username }
    : { authenticated: false });
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

app.get('/api/collection', requireAuth, async (req, res) => {
  try {
    const { username, accessToken, accessSecret } = req.session;
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
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

app.get('/api/release/:id', requireAuth, async (req, res) => {
  try {
    const data = await discogsGet(`/releases/${req.params.id}`, req.session.accessToken, req.session.accessSecret);
    res.json(data);
  } catch(e) { res.status(500).json({ error: 'Failed to fetch release' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Wax running on port ${PORT}`));
