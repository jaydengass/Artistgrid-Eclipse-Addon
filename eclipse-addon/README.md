# ArtistGrid Eclipse Addon

Eclipse Music addon that surfaces released and unreleased music from ArtistGrid trackers.

## Cloudflare Worker

The main addon implementation is `worker.js`. Deploy it to Cloudflare Workers.

### Local Dev

```bash
cd eclipse-addon
npx wrangler dev
```

### Deploy

```bash
cd eclipse-addon
npx wrangler deploy
```

## Endpoints

- `GET /manifest.json`
- `GET /search?q={query}&offset=0&limit=50`
- `GET /stream/{id}`
- `GET /artist/{id}?offset=0&limit=50`
- `GET /album/{id}?offset=0&limit=50`
- `GET /playlist/{id}` — not supported

## Install in Eclipse

Use your Worker URL (e.g. `https://artistgrid.artistgrid.cx`) in Eclipse:
**Settings → Connections → Add Connection → Addon**
