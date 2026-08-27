const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

const API_BASE = 'https://trackerapi.artistgrid.cx';
const ARTISTS_CSV = 'https://artists.artistgrid.cx/artists.csv';

let artistsCache = [];
let artistsCacheTime = 0;
const ARTISTS_CACHE_TTL = 1000 * 60 * 60;

let trackerCache = new Map();
const TRACKER_CACHE_TTL = 1000 * 60 * 5;

function normalizePillowsUrl(url) {
  return url.replace(/pillowcase\.su/g, 'pillows.su');
}

function extractImgurId(url) {
  let match = url.match(/\/f\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  match = url.match(/\/([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1] : null;
}

function extractSoundcloudPath(url) {
  const match = url.match(/soundcloud\.com\/([^/]+\/[^/?#]+)/);
  return match ? match[1] : null;
}

function getTrackSource(url) {
  const normalized = normalizePillowsUrl(url);
  if (/https?:\/\/pillows\.su\/f\//.test(normalized)) return 'pillows';
  if (/https?:\/\/(?:www\.|music\.)?youtube\.com\/|https?:\/\/youtu\.be\//.test(normalized)) return 'youtube';
  if (/https?:\/\/pixeldrain.com\/[du]\//.test(normalized)) return 'pixeldrain';
  if (/https?:\/\/juicewrldapi\.com\/juicewrld/.test(normalized)) return 'juicewrldapi';
  if (/https?:\/\/.*imgur\.gg/.test(normalized)) return 'imgur';
  if (/https?:\/\/(www\.)?soundcloud\.com\//.test(normalized)) return 'soundcloud';
  if (/https?:\/\/drive\.google\.com\/file\/d\//.test(normalized)) return 'googledrive';
  return 'unknown';
}

const NETWORK_SOURCES = new Set(['imgur', 'pixeldrain']);
const RESOLVE_SOURCES = new Set(['pillows', 'soundcloud', 'googledrive', 'juicewrldapi']);

function isNetworkSource(source) {
  return NETWORK_SOURCES.has(source);
}

function needsResolution(source) {
  return RESOLVE_SOURCES.has(source);
}

async function resolvePlayableUrl(url) {
  const normalized = normalizePillowsUrl(url);
  const source = getTrackSource(normalized);

  try {
    switch (source) {
      case 'pillows': {
        const match = normalized.match(/pillows\.su\/f\/([a-f0-9]+)/);
        return match ? `https://api.pillows.su/api/download/${match[1]}` : null;
      }
      case 'pixeldrain': {
        const match = normalized.match(/pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/);
        return match ? `https://fuck-unvaulted.artistgrid.cx/${match[1]}` : null;
      }
      case 'youtube':
        return null;
      case 'imgur': {
        const id = extractImgurId(normalized);
        if (!id) return null;
        const res = await fetch(`https://imgur.gg/api/file/${id}`);
        if (!res.ok) return null;
        const data = await res.json();
        const mediaType = data.mediaType || data.mimeType || data.type || '';
        if (mediaType.startsWith('image/')) return null;
        return data.cdnUrl || null;
      }
      case 'soundcloud': {
        const path = extractSoundcloudPath(normalized);
        return path ? `https://sc.monochrome.tf/_/restream/${path}` : null;
      }
      case 'juicewrldapi':
        return url;
      case 'googledrive': {
        const match = normalized.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
        return match ? `https://fuck-unvaulted.artistgrid.cx/gd/${match[1]}` : null;
      }
      default:
        return null;
    }
  } catch (error) {
    console.error(`Error resolving ${source} URL:`, error);
    return null;
  }
}

function encodeTrackId(url) {
  return Buffer.from(url).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTrackId(encoded) {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (base64.length % 4)) % 4;
    return Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

async function fetchArtistsCsv() {
  const now = Date.now();
  if (artistsCache.length > 0 && now - artistsCacheTime < ARTISTS_CACHE_TTL) {
    return artistsCache;
  }
  try {
    const res = await fetch(ARTISTS_CSV);
    if (!res.ok) throw new Error(`Failed to fetch artists CSV: ${res.status}`);
    const text = await res.text();
    const rows = text.split('\n');
    const headers = rows[0].split(',');
    const nameIdx = headers.indexOf('name');
    const urlIdx = headers.indexOf('url');
    
    const artists = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].trim();
      if (!row) continue;
      const fields = row.split(',');
      const name = fields[nameIdx];
      const url = fields[urlIdx];
      if (!name || !url) continue;
      artists.push({ name, url, trackerId: extractTrackerId(url) });
    }
    artistsCache = artists;
    artistsCacheTime = now;
    return artists;
  } catch (error) {
    console.error('Failed to fetch artists CSV:', error);
    return artistsCache;
  }
}

function extractTrackerId(input) {
  const cleanInput = input.replace(/\./g, '');
  const pubhtml = input.match(/\/spreadsheets\/d\/e\/(2PACX-[a-zA-Z0-9_-]+)\//);
  if (pubhtml) return pubhtml[1];
  const match = input.match(/\/spreadsheets(?:\/u\/\d+)?\/d\/([a-zA-Z0-9_-]{20,})/);
  if (match) return match[1];
  try {
    const url = new URL(input.trim());
    const hostname = url.hostname;
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(hostname)) return hostname;
  } catch {
    // ignore
  }
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input.trim())) return input.trim();
  if (/^[a-zA-Z0-9_-]+$/.test(cleanInput)) return cleanInput;
  return null;
}

async function fetchTrackerData(trackerId) {
  const now = Date.now();
  const cached = trackerCache.get(trackerId);
  if (cached && now - cached.time < TRACKER_CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(`${API_BASE}/sh/${encodeURIComponent(trackerId)}/`);
    if (!res.ok) return null;
    const data = await res.json();
    trackerCache.set(trackerId, { data, time: now });
    return data;
  } catch (error) {
    console.error(`Failed to fetch tracker ${trackerId}:`, error);
    return null;
  }
}

function adaptV3Track(v3Track) {
  const links = [];
  for (const l of v3Track.links || []) {
    if (l.url && (l.url.startsWith('http://') || l.url.startsWith('https://'))) {
      links.push(l.url);
    }
  }
  return {
    name: v3Track.name?.title || v3Track.name?.raw || 'Unknown',
    extra: v3Track.name?.credits?.length ? v3Track.name.credits.join(', ') : undefined,
    notes: v3Track.notes,
    track_length: v3Track.track_length ?? undefined,
    leak_date: v3Track.leak_date ?? undefined,
    file_date: v3Track.file_date ?? undefined,
    type: v3Track.type,
    available_length: v3Track.available_length,
    quality: v3Track.quality,
    url: links[0],
    urls: links,
    image: v3Track.image,
    id: links[0] ? encodeTrackId(links[0]) : encodeTrackId(v3Track.name?.title || v3Track.name?.raw || 'untitled'),
  };
}

function adaptV3Response(v3) {
  const eras = {};
  for (let i = 0; i < (v3.eras?.length || 0); i++) {
    const v3Era = v3.eras[i];
    const key = `${i}:${v3Era.name || ''}`;
    const grouped = {};
    for (const track of v3Era.tracks || []) {
      const group = track.sub_era || 'Default';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(adaptV3Track(track));
    }
    eras[key] = {
      name: v3Era.name,
      extra: v3Era.aka?.join(', '),
      image: v3Era.cover_art,
      eraLogo: v3Era.era_logo,
      textColor: v3Era.text_color,
      backgroundColor: v3Era.color,
      font: v3Era.font_family || v3Era.font,
      description: v3Era.description,
      data: Object.keys(grouped).length > 0 ? grouped : undefined,
    };
  }

  const result = {
    name: v3.name,
    tab: v3.tab,
    tabs: v3.tabs || [],
    eras,
    era_dates: v3.era_dates || [],
    credits: v3.credits || '',
    discord: Array.isArray(v3.discord) ? (v3.discord[0] || undefined) : v3.discord,
    lastUpdated: v3.last_updated ? new Date(v3.last_updated * 1000).toISOString() : undefined,
  };

  if (v3.era_dates?.length) {
    const datesByEra = new Map();
    for (const ed of v3.era_dates) {
      if (!datesByEra.has(ed.era)) datesByEra.set(ed.era, []);
      datesByEra.get(ed.era).push(ed);
    }
    for (const key of Object.keys(result.eras)) {
      const era = result.eras[key];
      era.era_dates = datesByEra.get(era.name) || [];
    }
  }

  return result;
}

function adaptV3FlatResponse(v3) {
  const grouped = {};
  for (const track of v3.tracks || []) {
    const eraName = track.era || 'Unknown';
    if (!grouped[eraName]) {
      grouped[eraName] = [];
    }
    const taLeak = adaptV3Track(track);
    taLeak.eraName = eraName;
    taLeak.eraColor = track.era_color;
    taLeak.eraTextColor = track.era_text_color;
    taLeak.eraFont = track.era_font || track.font_family;
    grouped[eraName].push(taLeak);
  }

  const eras = {};
  for (const [eraName, eraTracks] of Object.entries(grouped)) {
    const firstTrack = eraTracks[0];
    eras[eraName] = {
      name: eraName,
      backgroundColor: firstTrack.eraColor,
      textColor: firstTrack.eraTextColor,
      font: firstTrack.eraFont,
      data: { Default: eraTracks }
    };
  }

  return {
    name: v3.name,
    tab: v3.tab,
    tabs: v3.tabs || [],
    eras,
    isFlat: true,
    era_dates: v3.era_dates || [],
    credits: v3.credits || '',
    discord: Array.isArray(v3.discord) ? (v3.discord[0] || undefined) : v3.discord,
    lastUpdated: v3.last_updated ? new Date(v3.last_updated * 1000).toISOString() : undefined,
  };
}

function buildTabMeta(v3) {
  const tabNames = v3.tabs?.map(t => t.name) || [];
  if (!tabNames.includes(v3.tab?.name) && v3.tab?.name) tabNames.unshift(v3.tab.name);
  const tabSlugs = {};
  const tabGids = {};
  for (const t of v3.tabs || []) {
    tabSlugs[t.name] = t.slug;
    tabGids[t.name] = t.gid;
  }
  if (v3.tab && !tabSlugs[v3.tab.name]) tabSlugs[v3.tab.name] = v3.tab.slug;
  if (v3.tab && !tabGids[v3.tab.name]) tabGids[v3.tab.name] = v3.tab.gid;
  return { tabs: tabNames, tabSlugs, tabGids, current_tab: v3.tab?.name || '' };
}

async function loadTrackerData(trackerId, tab) {
  const cacheKey = tab || 'base';
  const now = Date.now();
  const cached = trackerCache.get(`${trackerId}:${cacheKey}`);
  if (cached && now - cached.time < TRACKER_CACHE_TTL) {
    return cached.data;
  }

  const endpoint = tab ? `/sh/${encodeURIComponent(trackerId)}/tab/${encodeURIComponent(tab)}` : `/sh/${encodeURIComponent(trackerId)}/`;
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) return null;
    const v3 = await res.json();
    const data = v3 && Array.isArray(v3.tracks) && v3.tracks.length > 0
      ? adaptV3FlatResponse(v3)
      : adaptV3Response(v3);
    trackerCache.set(`${trackerId}:${cacheKey}`, { data, time: now });
    return data;
  } catch (error) {
    console.error(`Failed to load tracker ${trackerId} tab ${tab}:`, error);
    return null;
  }
}

async function loadMergedTrackerData(trackerId) {
  const cacheKey = 'merged';
  const now = Date.now();
  const cached = trackerCache.get(`${trackerId}:${cacheKey}`);
  if (cached && now - cached.time < TRACKER_CACHE_TTL) {
    return cached.data;
  }

  const [base, released] = await Promise.all([
    loadTrackerData(trackerId),
    loadTrackerData(trackerId, 'released')
  ]);

  if (!base && !released) {
    return null;
  }

  if (!base) return released;
  if (!released) return base;

  const baseEraNames = new Set();
  for (const [, era] of Object.entries(base.eras)) {
    if (era.name) baseEraNames.add(era.name);
  }

  const mergedEras = { ...base.eras };
  for (const [key, era] of Object.entries(released.eras)) {
    const eraName = era.name || '';
    const existingEntry = Object.entries(mergedEras).find(([, e]) => (e.name || '') === eraName);
    if (existingEntry && era.data) {
      const [existingKey, existingEra] = existingEntry;
      const mergedData = { ...existingEra.data };
      for (const [cat, catTracks] of Object.entries(era.data)) {
        if (!Array.isArray(catTracks)) continue;
        if (mergedData[cat]) {
          mergedData[cat] = [...mergedData[cat], ...catTracks];
        } else {
          mergedData[cat] = catTracks;
        }
      }
      mergedEras[existingKey] = { ...existingEra, data: mergedData };
    } else {
      let finalKey = key;
      let finalName = eraName;
      if (baseEraNames.has(eraName) && eraName) {
        finalName = `${eraName} (Released)`;
      }
      const existing = Object.entries(mergedEras).find(([, e]) => (e.name || '') === finalName);
      if (existing) {
        finalKey = existing[0];
      } else {
        finalKey = finalName || key;
      }
      mergedEras[finalKey] = { ...era, name: finalName };
    }
  }

  const baseTabSlugs = new Set((base.tabs || []).map(t => t.slug));
  const mergedTabs = [...(base.tabs || [])];
  for (const t of released.tabs || []) {
    if (!baseTabSlugs.has(t.slug)) {
      mergedTabs.push(t);
    }
  }

  const mergedEraDates = [
    ...(base.era_dates || []),
    ...(released.era_dates || [])
  ];

  return {
    ...base,
    eras: mergedEras,
    tabs: mergedTabs,
    era_dates: mergedEraDates
  };
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'cx.artistgrid.eclipse',
    name: 'ArtistGrid',
    version: '0.1.2',
    description: 'Streams released and unreleased music from ArtistGrid trackers',
    icon: 'https://raw.githubusercontent.com/artistgrid/apps/main/src-tauri/icons/icon.png',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist'],
    contentType: 'music'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  if (!query) {
    return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  }

  try {
    const artists = await fetchArtistsCsv();
    let matches = artists.filter(a => a.name.toLowerCase().includes(query)).slice(0, 8);

    let searchArtists = matches;
    if (searchArtists.length === 0) {
      const popularIds = new Set([
        '12nGHPPh5dVTfLuBLVQYzC3QgPxKfvp-jgCoNccvEasM',
        '1FUzAZyTCgFTVxQ--qbCAS2bUk4dsAw6ASxwjURPHbyI',
        '1i4OQglDHiiqMDthqfUFPutGmpZzK7n63LaoWApqhQXI',
        '1v55XAPLzw1iuWxH1OQKajCIYPhW2BXcLoV4mXDZ55DI',
        '1gJqbQrb3dIWF-PLMsKkNUrftpQb8zxsZFDAIpSvT5Fo',
        '1alPlu5jpMv5-HbyKkBX-gH5SC4QPZH90StbAaUA9o0k',
        '1OARID98xCqRaBr8gyQCvI3aD4jKQDGgtedyRaiP_pyo',
        '1tD3ytt5wPx4zfcefXi5ATeYhIiDaugWjMS46nZrP568',
      ]);
      searchArtists = artists.filter(a => popularIds.has(a.trackerId)).slice(0, 5);
      if (searchArtists.length === 0) {
        searchArtists = artists.slice(0, 5);
      }
    }

    const artistResults = matches.map(a => ({
      id: a.trackerId || a.url,
      name: a.name,
      artworkURL: `https://assets.artistgrid.cx/webp/${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.webp`,
      type: 'artist'
    }));

    const trackPromises = searchArtists.map(async (artist) => {
      const trackerId = artist.trackerId;
      if (!trackerId) return null;
      const data = await loadMergedTrackerData(trackerId);
      if (!data) return null;

      const tracks = [];
      const albums = [];
      const queryLower = query.toLowerCase();
      for (const [eraKey, era] of Object.entries(data.eras)) {
        if (era.data) {
          for (const [cat, catTracks] of Object.entries(era.data)) {
            if (!Array.isArray(catTracks)) continue;
            for (const track of catTracks) {
              const allUrls = track.urls || (track.url ? [track.url] : []);
              const playableUrl = allUrls.length > 0 ? allUrls[0] : null;
              if (!playableUrl) continue;
              const source = getTrackSource(playableUrl);
              if (source === 'youtube' || source === 'unknown') continue;

              const trackTitle = (track.name || '').toLowerCase();
              const artistMatch = artist.name.toLowerCase().includes(queryLower);
              const trackMatch = trackTitle.includes(queryLower);
              if (!artistMatch && !trackMatch) continue;

              tracks.push({
                id: track.id || encodeTrackId(playableUrl),
                title: track.name || 'Unknown',
                artist: artist.name,
                album: era.name,
                duration: track.track_length ? parseInt(track.track_length) : undefined,
                artworkURL: track.image || era.image,
                isrc: undefined,
                format: source === 'youtube' ? undefined : 'mp3',
                streamURL: (isNetworkSource(source) || needsResolution(source)) ? undefined : playableUrl
              });
            }
            if (catTracks.length > 0) {
              albums.push({
                id: `${trackerId}:${eraKey}`,
                title: era.name,
                artist: artist.name,
                artworkURL: era.image,
                trackCount: catTracks.length,
                year: undefined
              });
            }
          }
        }
      }
      return { tracks, albums };
    });

    const results = await Promise.all(trackPromises);
    const allTracks = [];
    const allAlbums = [];
    for (const r of results) {
      if (!r) continue;
      allTracks.push(...r.tracks);
      allAlbums.push(...r.albums);
    }

    res.json({
      tracks: allTracks.slice(0, 200),
      albums: allAlbums.slice(0, 30),
      artists: artistResults,
      playlists: []
    });
  } catch (error) {
    console.error('Search error:', error);
    res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  }
});

app.get('/stream/:id', async (req, res) => {
  const encodedId = req.params.id;
  const url = decodeTrackId(encodedId);
  if (!url) {
    return res.status(400).json({ error: 'Invalid track ID' });
  }

  try {
    const playableUrl = await resolvePlayableUrl(url);
    if (!playableUrl) {
      return res.status(404).json({ error: 'Could not resolve playable URL' });
    }

    const source = getTrackSource(url);
    let format = 'mp3';
    if (source === 'youtube') format = 'mp3';
    else if (source === 'soundcloud') format = 'mp3';
    else if (source === 'pixeldrain') format = 'mp3';

    res.json({
      url: playableUrl,
      format,
      quality: '320kbps'
    });
  } catch (error) {
    console.error('Stream resolution error:', error);
    res.status(500).json({ error: 'Stream resolution failed' });
  }
});

app.get('/artist/:id', async (req, res) => {
  const trackerId = req.params.id;
  try {
    const data = await loadMergedTrackerData(trackerId);
    if (!data) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const tracks = [];
    const albums = [];
    for (const [eraKey, era] of Object.entries(data.eras)) {
      if (era.data) {
        for (const [cat, catTracks] of Object.entries(era.data)) {
          if (!Array.isArray(catTracks)) continue;
          for (const track of catTracks) {
            const allUrls = track.urls || (track.url ? [track.url] : []);
            const playableUrl = allUrls.length > 0 ? allUrls[0] : null;
            if (!playableUrl) continue;
            const source = getTrackSource(playableUrl);
            if (source === 'youtube' || source === 'unknown') continue;
            tracks.push({
              id: track.id || encodeTrackId(playableUrl),
              title: track.name || 'Unknown',
              artist: data.name || 'Unknown Artist',
              album: era.name,
              duration: track.track_length ? parseInt(track.track_length) : undefined,
              artworkURL: track.image || era.image,
              isrc: undefined,
              format: source === 'youtube' ? undefined : 'mp3',
              streamURL: (isNetworkSource(source) || needsResolution(source)) ? undefined : playableUrl
            });
          }
          if (catTracks.length > 0) {
            albums.push({
              id: `${trackerId}:${eraKey}`,
              title: era.name,
              artist: data.name || 'Unknown Artist',
              artworkURL: era.image,
              trackCount: catTracks.length,
              year: undefined
            });
          }
        }
      }
    }

    res.json({
      id: trackerId,
      name: data.name || 'Unknown Artist',
      artworkURL: Object.values(data.eras)[0]?.image || `https://assets.artistgrid.cx/webp/${(data.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '')}.webp`,
      bio: data.credits,
      genres: [],
      topTracks: tracks.slice(0, 10),
      albums: albums.slice(0, 10)
    });
  } catch (error) {
    console.error('Artist detail error:', error);
    res.status(500).json({ error: 'Failed to load artist' });
  }
});

app.get('/album/:id', async (req, res) => {
  const albumId = req.params.id;
  const firstColon = albumId.indexOf(':');
  if (firstColon === -1) {
    return res.status(400).json({ error: 'Invalid album ID' });
  }
  const trackerId = albumId.substring(0, firstColon);
  const eraKey = albumId.substring(firstColon + 1);

  if (!trackerId || !eraKey) {
    return res.status(400).json({ error: 'Invalid album ID' });
  }

  try {
    const data = await loadMergedTrackerData(trackerId);
    if (!data) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const era = data.eras[eraKey];
    if (!era) {
      return res.status(404).json({ error: 'Era not found' });
    }

    const tracks = [];
    if (era.data) {
      for (const [cat, catTracks] of Object.entries(era.data)) {
        if (!Array.isArray(catTracks)) continue;
        for (const track of catTracks) {
          const allUrls = track.urls || (track.url ? [track.url] : []);
          const playableUrl = allUrls.length > 0 ? allUrls[0] : null;
          if (!playableUrl) continue;
          const source = getTrackSource(playableUrl);
          if (source === 'youtube' || source === 'unknown') continue;
          tracks.push({
            id: track.id || encodeTrackId(playableUrl),
            title: track.name || 'Unknown',
            artist: data.name || 'Unknown Artist',
            album: era.name,
            duration: track.track_length ? parseInt(track.track_length) : undefined,
            artworkURL: track.image || era.image,
            isrc: undefined,
            format: source === 'youtube' ? undefined : 'mp3',
            streamURL: (isNetworkSource(source) || needsResolution(source)) ? undefined : playableUrl
          });
        }
      }
    }

    res.json({
      id: albumId,
      title: era.name,
      artist: data.name || 'Unknown Artist',
      artworkURL: era.image,
      year: undefined,
      description: era.description,
      trackCount: tracks.length,
      tracks
    });
  } catch (error) {
    console.error('Album detail error:', error);
    res.status(500).json({ error: 'Failed to load album' });
  }
});

app.get('/playlist/:id', (req, res) => {
  res.status(501).json({ error: 'Playlists are not supported by ArtistGrid' });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

console.log('Environment PORT:', process.env.PORT);
console.log('Resolved PORT:', PORT);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`ArtistGrid Eclipse addon listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
