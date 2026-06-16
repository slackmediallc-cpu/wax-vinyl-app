# Wax — Setup Guide

Follow these steps to get your app live on the internet, working on every device.

---

## Step 1 — Create a free GitHub account (if you don't have one)
Go to github.com and sign up. It's free.

---

## Step 2 — Create a new GitHub repository
1. Click the "+" icon → "New repository"
2. Name it: `wax-vinyl-app`
3. Set to **Public**
4. Click "Create repository"

---

## Step 3 — Upload the app files
1. Click "uploading an existing file" on the new repo page
2. Upload ALL files from the `wax-app` folder:
   - `server.js`
   - `package.json`
   - `public/index.html`
3. Click "Commit changes"

---

## Step 4 — Get your Discogs API credentials
1. Go to discogs.com → Settings → Developers
2. Click "Register a new OAuth application"
3. Fill in:
   - **Application name:** Wax Vinyl App
   - **Application website:** (your Render URL — you'll get this in Step 6, come back and update it)
   - **Callback URL:** https://YOUR-RENDER-URL.onrender.com/auth/callback
4. Save — you'll get a **Consumer Key** and **Consumer Secret**

---

## Step 5 — Deploy to Render.com (free)
1. Go to render.com and sign up with your GitHub account
2. Click "New +" → "Web Service"
3. Connect your `wax-vinyl-app` GitHub repository
4. Configure:
   - **Name:** wax-vinyl-app
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Click "Create Web Service"
6. Wait ~2 minutes for it to deploy
7. Copy your Render URL (looks like `https://wax-vinyl-app.onrender.com`)

---

## Step 6 — Add environment variables in Render
In your Render dashboard → your service → "Environment":

| Key | Value |
|-----|-------|
| `DISCOGS_KEY` | Your Consumer Key from Step 4 |
| `DISCOGS_SECRET` | Your Consumer Secret from Step 4 |
| `SESSION_SECRET` | Any random string (e.g. `wax-secret-abc123-xyz`) |
| `APP_URL` | Your full Render URL (e.g. `https://wax-vinyl-app.onrender.com`) |

Click "Save Changes" — Render will redeploy automatically.

---

## Step 7 — Update your Discogs callback URL
Go back to discogs.com → Settings → Developers → your app:
- Update **Callback URL** to: `https://YOUR-RENDER-URL.onrender.com/auth/callback`

---

## Step 8 — Test it!
1. Open your Render URL in any browser
2. Tap "Connect with Discogs"
3. Authorize the app on Discogs
4. Your full collection loads automatically!

Works on iPhone, Android, desktop — any browser, any device.

---

## Sharing with others
Anyone can use the app by going to your Render URL and signing in with their own Discogs account. Their collection loads automatically — no tokens, no CSV exports.

---

## Notes
- The free Render plan "sleeps" after 15 minutes of inactivity. First load after sleeping takes ~30 seconds to wake up. Paid plan ($7/mo) keeps it always-on.
- Your Discogs token is never stored in the app — OAuth handles auth securely.
