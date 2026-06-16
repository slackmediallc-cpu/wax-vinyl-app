const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fetch = require('node-fetch');
const OAuth = require('oauth').OAuth;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (set these in Render dashboard)
const DISCOGS_KEY = process.env.DISCOGS_KEY || '';
const DISCOGS_SECRET = process.env.DISCOGS_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'wax-super-secret-change-this';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const DISCOGS_API = 'https://api.discogs.com';
const CALLBACK_URL = `${APP_URL}/auth/callback`;

// OAuth client
function makeOAuth(token, tokenSecret) {
  return new OAuth(
    'https://api.discogs.com/oauth/request_token',
    'https://api.discogs.com/oauth/access_token',
    DISCOGS_KEY,
    DISCOGS_SECRET,
    '1.0',
    CALLBACK_URL,
    'HMAC-SHA1'
  );
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ROUTES ──────────────────────────────────────────────

// Step 1: Start OAuth flow
app.get('/auth/login', (req, res) => {
  if (!DISCOGS_KEY || !DISCOGS_SECRET) {
    return res.status(500).json({ error: 'Discogs API keys not configured. Add DISCOGS_KEY and DISCOGS_SECRET in Render environment variables.' });
  }
  const oa = makeOAuth();
  oa.getOAuthRequestToken((err, token, secret) => {
    if (err) {
      console.error('Request token error:', err);
      return res.status(500).json({ error: 'Failed to start OAuth. Check your Discogs API credentials.' });
    }
    req.session.oauthToken = token;
    req.session.oauthSecret = secret;
    res.redirect(`https://discogs.com/oauth/authorize?oauth_token=${token}`);
  });
});

// Step 2: OAuth callback
app.get('/auth/callback', (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const oa = makeOAuth();
  oa.getOAuthAccessToken(
    oauth_token,
    req.session.oauthSecret,
    oauth_verifier,
    async (err, accessToken, accessSecret) => {
      if (err) {
        console.error('Access token error:', err);
        return res.redirect('/?error=auth_failed');
      }
      // Get user identity
      try {
        const identity = await discogsRequest('/oauth/identity', accessToken, accessSecret);
        req.session.accessToken = accessToken;
        req.session.accessSecret = accessSecret;
        req.session.username = identity.username;
        req.session.userAvatar = identity.avatar_url;
        res.redirect('/?auth=success');
      } catch(e) {
        res.redirect('/?error=identity_failed');
      }
    }
  );
});

// Step 3: Check auth status
app.get('/auth/status', (req, res) => {
  if (req.session.username) {
    res.json({ authenticated: true, username: req.session.username, avatar: req.session.userAvatar });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── API PROXY ROUTES ─────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.username) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

async function discogsRequest(endpoint, token, secret) {
  const oa = makeOAuth();
  return new Promise((resolve, reject) => {
    oa.get(
      `${DISCOGS_API}${endpoint}`,
      token,
      secret,
      (err, data) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      }
    );
  });
}

// Get full collection (handles pagination)
app.get('/api/collection', requireAuth, async (req, res) => {
  try {
    const { username, accessToken, accessSecret } = req.session;
    let page = 1, all = [];
    while (true) {
      const data = await discogsRequest(
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

// Get single release details
app.get('/api/release/:id', requireAuth, async (req, res) => {
  try {
    const data = await discogsRequest(
      `/releases/${req.params.id}`,
      req.session.accessToken, req.session.accessSecret
    );
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Failed to fetch release' });
  }
});

// Search Discogs
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = encodeURIComponent(req.query.q || '');
    const data = await discogsRequest(
      `/database/search?q=${q}&type=release&per_page=10`,
      req.session.accessToken, req.session.accessSecret
    );
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── FALLBACK ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wax server running on port ${PORT}`);
  console.log(`App URL: ${APP_URL}`);
  if (!DISCOGS_KEY) console.warn('WARNING: DISCOGS_KEY not set');
});
