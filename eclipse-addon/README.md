# ArtistGrid Eclipse Addon

Eclipse Music addon that surfaces unreleased music from ArtistGrid trackers.

## Deploy to Railway

1. Push this folder to GitHub
2. In Railway, create a new project → **Deploy from GitHub**
3. Select this repo
4. Railway auto-detects Node.js and runs `npm start`
5. After deploy, Railway gives you a public URL like `https://your-app.up.railway.app`
6. Use that URL in Eclipse: **Settings → Connections → Add Connection → Addon**

## Local Dev

```bash
cd eclipse-addon
npm install
npm start
```

Server runs on `http://localhost:3000` by default.

## Endpoints

- `GET /manifest.json`
- `GET /search?q={query}`
- `GET /stream/{id}`
- `GET /artist/{id}`
- `GET /album/{id}`
- `GET /playlist/{id}` — not supported

## Note

If you fork/clone this repo, make sure the `eclipse-addon` folder is the deploy root in Railway, or move `package.json`, `server.js`, and `railway.toml` to the repo root.
