const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCOGS_KEY = process.env.DISCOGS_KEY || '';
const DISCOGS_SECRET = process.env.DISCOGS_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'wax-secret';
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CALLBACK_URL = `${APP_URL}/auth/callback`;
const DISCOGS_API = 'https://api.discogs.com';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── OAuth 1.0a helpers (built from scratch, no buggy library) ──

function encodeRFC3986(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function buildOAuthHeader(method, url, params, tokenSecret = '') {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: DISCOGS_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
    ...params,
  };

  // Sort and build base string
  const sortedParams = Object.keys(oauthParams).sort().map(k =>
    `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k])}`
  ).join('&');

  const baseString = [
    method.toUpperCase(),
    encodeRFC3986(url),
    encodeRFC3986(sortedParams)
  ].join('&');

  const signingKey = `${encodeRFC3986(DISCOGS_SECRET)}&${encodeRFC3986(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const headerValue = 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
    `${encodeRFC3986(k)}="${encodeRFC3986(oauthParams[k])}"`
  ).join(', ');

  return headerValue;
}

async function discogsOAuthGet(endpoint, accessToken, accessSecret) {
  const url = `${DISCOGS_API}${endpoint}`;
  const header = buildOAuthHeader('GET', url, {
    oauth_token: accessToken,
  }, accessSecret);
  const res = await fetch(url, {
    headers: {
      'Authorization': header,
      'User-Agent': 'WaxVinylApp/1.0',
    }
  });
  if (!res.ok) throw new Error(`Discogs API error: ${res.status}`);
  return res.json();
}

// ── Auth routes ──

app.get('/auth/login', async (req, res) => {
  if (!DISCOGS_KEY || !DISCOGS_SECRET) {
    return res.status(500).json({ error: 'Discogs API keys not configured.' });
  }
  try {
    const url = 'https://api.discogs.com/oauth/request_token';
    const header = buildOAuthHeader('POST', url, {
      oauth_callback: CALLBACK_URL,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': header,
        'User-Agent': 'WaxVinylApp/1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });
    const text = await response.text();
    if (!response.ok) {
      console.error('Request token failed:', response.status, text);
      return res.status(500).json({ error: 'Failed to get request token from Discogs.' });
    }
    const params = new URLSearchParams(text);
    const token = params.get('oauth_token');
    const secret = params.get('oauth_token_secret');
    req.session.oauthToken = token;
    req.session.oauthSecret = secret;
    res.redirect(`https://discogs.com/oauth/authorize?oauth_token=${token}`);
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'OAuth login failed.' });
  }
});

app.get('/auth/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  try {
    const url = 'https://api.discogs.com/oauth/access_token';
    const header = buildOAuthHeader('POST', url, {
      oauth_token: oauth_token,
      oauth_verifier: oauth_verifier,
    }, req.session.oauthSecret);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': header,
        'User-Agent': 'WaxVinylApp/1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    });
    const text = await response.text();
    if (!response.ok) {
      console.error('Access token failed:', response.status, text);
      return res.redirect('/?error=auth_failed');
    }
    const params = new URLSearchParams(text);
    const accessToken = params.get('oauth_token');
    const accessSecret = params.get('oauth_token_secret');
    const identity = await discogsOAuthGet('/oauth/identity', accessToken, accessSecret);
    req.session.accessToken = accessToken;
    req.session.accessSecret = accessSecret;
    req.session.username = identity.username;
    req.session.userAvatar = identity.avatar_url;
    res.redirect('/?auth=success');
  } catch(e) {
    console.error('Callback error:', e);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  if (req.session.username) {
    res.json({ authenticated: true, username: req.session.username, avatar: req.session.userAvatar });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── API routes ──

function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

app.get('/api/collection', requireAuth, async (req, res) => {
  try {
    const { username, accessToken, accessSecret } = req.session;
    let page = 1, all = [];
    while (true) {
      const data = await discogsOAuthGet(
        `/users/${username}/collection/folders/0/releases?per_page=100&page=${page}&sort=artist&sort_order=asc`,
        accessToken, accessSecret
      );
      all = all.concat(data.releases || []);
      if (page >= (data.pagination?.pages || 1)) break;
      page++;
    }
    res.json({ releases: all, total: all.length, username });
  } catch(e) {
    console.error('Collection error:', e);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

app.get('/api/release/:id', requireAuth, async (req, res) => {
  try {
    const data = await discogsOAuthGet(`/releases/${req.params.id}`, req.session.accessToken, req.session.accessSecret);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Failed to fetch release' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wax server running on port ${PORT}`);
  if (!DISCOGS_KEY) console.warn('WARNING: DISCOGS_KEY not set');
});
