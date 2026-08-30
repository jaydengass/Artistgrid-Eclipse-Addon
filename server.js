const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_BASE = 'https://trackerapi.artistgrid.cx';
const ARTISTS_CSV = 'https://artists.artistgrid.cx/artists.csv';

const ARTISTS_CACHE_TTL = 1000 * 60 * 60;
const TRACKER_CACHE_TTL = 1000 * 60 * 5;

const artistsCache = [];
let artistsCacheTime = 0;

const trackerCache = new Map();

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
  if (/https?:\/\/pixeldrain\.com\/[du]\//.test(normalized)) return 'pixeldrain';
  if (/https?:\/\/juicewrldapi\.com\/juicewrld/.test(normalized)) return 'juicewrldapi';
  if (/https?:\/\/imgur\.gg\//.test(normalized)) return 'imgur';
  if (/https?:\/\/(?:www\.)?soundcloud\.com\//.test(normalized)) return 'soundcloud';
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

function base64UrlEncode(str) {
  const base64 = Buffer.from(str, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const binary = Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf8');
  return binary;
}

function encodeTrackId(url) {
  return base64UrlEncode(url);
}

function decodeTrackId(encoded) {
  try {
    return base64UrlDecode(encoded);
  } catch {
    return null;
  }
}

function isUrl(str) {
  if (!str || typeof str !== 'string') return false;
  return str.startsWith('http://') || str.startsWith('https://');
}

function parseDuration(value, fallback) {
  if (typeof value === 'number') {
    if (value > 0) return value;
  } else if (!value) {
    if (typeof fallback === 'number' && fallback > 0) return fallback;
    return undefined;
  } else {
    const str = String(value).trim();
    if (!str) {
      if (typeof fallback === 'number' && fallback > 0) return fallback;
      return undefined;
    }
    if (/^\d+$/.test(str)) {
      const num = parseInt(str, 10);
      if (num > 0) return num;
    } else {
      const match = str.match(/^(\d+):(\d{2})$/);
      if (match) {
        const seconds = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
        if (seconds > 0) return seconds;
      }
      const num = parseInt(str, 10);
      if (!isNaN(num) && num > 0) return num;
    }
  }
  if (typeof fallback === 'number' && fallback > 0) return fallback;
  return undefined;
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

function getAllTrackUrls(track) {
  const urls = [];
  if (track.urls) {
    for (const u of track.urls) {
      if (isUrl(u)) urls.push(normalizePillowsUrl(u));
    }
  }
  if (urls.length === 0 && track.url && isUrl(track.url)) {
    urls.push(normalizePillowsUrl(track.url));
  }
  if (urls.length === 0 && track.quality && isUrl(track.quality)) {
    urls.push(normalizePillowsUrl(track.quality));
  }
  if (urls.length === 0 && track.available_length && isUrl(track.available_length)) {
    urls.push(normalizePillowsUrl(track.available_length));
  }
  return urls;
}

function pickPlayableUrl(track) {
  const allUrls = getAllTrackUrls(track);
  for (const u of allUrls) {
    const source = getTrackSource(u);
    if (source !== 'youtube' && source !== 'unknown') {
      return { url: u, source };
    }
  }
  return null;
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
    artistsCache.length = 0;
    artistsCache.push(...artists);
    artistsCacheTime = now;
    return artistsCache;
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

  const merged = {
    ...base,
    eras: mergedEras,
    tabs: mergedTabs,
    era_dates: mergedEraDates
  };

  trackerCache.set(`${trackerId}:${cacheKey}`, { data: merged, time: now });
  return merged;
}

function jsonResponse(data, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: data };
}

function buildTrackItem(track, era, artistName, trackerId, playableUrl, source) {
  return {
    id: encodeTrackId(playableUrl),
    title: track.name || 'Unknown',
    artist: artistName || 'Unknown Artist',
    album: era.name,
    duration: parseDuration(track.track_length, track.available_length),
    artworkURL: track.image || era.image,
    isrc: undefined,
    format: source === 'youtube' ? undefined : 'mp3',
    streamURL: (isNetworkSource(source) || needsResolution(source)) ? undefined : playableUrl
  };
}

function buildAlbumItem(trackerId, eraKey, era, artistName, eraTrackCount) {
  return {
    id: `${trackerId}:${eraKey}`,
    title: era.name,
    artist: artistName,
    artworkURL: era.image,
    trackCount: eraTrackCount,
    year: undefined
  };
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'cx.artistgrid.eclipse',
    name: 'ArtistGrid',
    version: '1.0.0',
    description: 'Streams released and unreleased music from ArtistGrid trackers',
    icon: 'https://avatars.githubusercontent.com/u/221340129?s=200&v=4',
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  if (!query) {
    return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  }

  try {
    const artists = await fetchArtistsCsv();
    const matches = artists.filter(a => a.name.toLowerCase().includes(query));

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
      searchArtists = artists.filter(a => popularIds.has(a.trackerId));
      if (searchArtists.length === 0) {
        searchArtists = artists;
      }
    }

    const trackPromises = searchArtists.map(async (artist) => {
      const trackerId = artist.trackerId;
      if (!trackerId) return null;
      const data = await loadMergedTrackerData(trackerId);
      if (!data) return null;

      const tracks = [];
      const albums = [];
      const queryLower = query.toLowerCase();
      for (const [eraKey, era] of Object.entries(data.eras)) {
        if (!era.data) continue;

        let eraTrackCount = 0;
        for (const catTracks of Object.values(era.data)) {
          if (Array.isArray(catTracks)) eraTrackCount += catTracks.length;
        }

        let albumMatch = (era.name || '').toLowerCase().includes(queryLower);
        let matchedTracks = 0;
        for (const [cat, catTracks] of Object.entries(era.data)) {
          if (!Array.isArray(catTracks)) continue;
          for (const track of catTracks) {
            const picked = pickPlayableUrl(track);
            if (!picked) continue;
            const { url: playableUrl, source } = picked;

            const trackTitle = (track.name || '').toLowerCase();
            const artistMatch = artist.name.toLowerCase().includes(queryLower);
            const trackMatch = trackTitle.includes(queryLower);
            if (!artistMatch && !trackMatch && !albumMatch) continue;

            tracks.push(buildTrackItem(track, era, artist.name, trackerId, playableUrl, source));
            matchedTracks++;
          }
        }

        if ((albumMatch || matchedTracks > 0) && eraTrackCount > 0) {
          albums.push(buildAlbumItem(trackerId, eraKey, era, artist.name, eraTrackCount));
        }
      }
      return { tracks, albums };
    });

    const results = await Promise.all(trackPromises);
    const allTracks = [];
    const allAlbums = [];
    const matchedArtistIds = new Set();
    for (const r of results) {
      if (!r) continue;
      allTracks.push(...r.tracks);
      allAlbums.push(...r.albums);
      for (const t of r.tracks) {
        if (t.artist) matchedArtistIds.add(t.artist);
      }
    }

    const pagedTracks = allTracks.slice(offset, offset + limit);
    const pagedAlbums = allAlbums.slice(offset, offset + limit);

    const matchedArtistNames = new Set(matches.map(a => a.name));
    const artistResults = artists
      .filter(a => matchedArtistNames.has(a.name) || matchedArtistIds.has(a.name))
      .slice(offset, offset + limit)
      .map(a => ({
        id: a.trackerId || a.url,
        name: a.name,
        artworkURL: `https://assets.artistgrid.cx/webp/${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.webp`,
        type: 'artist'
      }));

    res.json({
      tracks: pagedTracks,
      albums: pagedAlbums,
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
  const decodedUrl = decodeTrackId(encodedId);
  if (!decodedUrl) {
    return res.status(400).json({ error: 'Invalid track ID' });
  }

  try {
    const playableUrl = await resolvePlayableUrl(decodedUrl);
    if (!playableUrl) {
      return res.status(404).json({ error: 'Could not resolve playable URL' });
    }

    const source = getTrackSource(decodedUrl);
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const data = await loadMergedTrackerData(trackerId);
    if (!data) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const tracks = [];
    const albums = [];
    for (const [eraKey, era] of Object.entries(data.eras)) {
      if (!era.data) continue;

      let eraTrackCount = 0;
      for (const catTracks of Object.values(era.data)) {
        if (Array.isArray(catTracks)) eraTrackCount += catTracks.length;
      }

      for (const [cat, catTracks] of Object.entries(era.data)) {
        if (!Array.isArray(catTracks)) continue;
        for (const track of catTracks) {
          const picked = pickPlayableUrl(track);
          if (!picked) continue;
          const { url: playableUrl, source } = picked;
          tracks.push(buildTrackItem(track, era, data.name || 'Unknown Artist', trackerId, playableUrl, source));
        }
      }

      if (eraTrackCount > 0) {
        albums.push(buildAlbumItem(trackerId, eraKey, era, data.name || 'Unknown Artist', eraTrackCount));
      }
    }

    res.json({
      id: trackerId,
      name: data.name || 'Unknown Artist',
      artworkURL: Object.values(data.eras)[0]?.image || `https://assets.artistgrid.cx/webp/${(data.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '')}.webp`,
      bio: data.credits,
      genres: [],
      topTracks: tracks.slice(offset, offset + limit),
      albums: albums.slice(offset, offset + limit)
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

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

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
          const picked = pickPlayableUrl(track);
          if (!picked) continue;
          const { url: playableUrl, source } = picked;
          tracks.push(buildTrackItem(track, era, data.name || 'Unknown Artist', trackerId, playableUrl, source));
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
      tracks: tracks.slice(offset, offset + limit)
    });
  } catch (error) {
    console.error('Album detail error:', error);
    res.status(500).json({ error: 'Failed to load album' });
  }
});

app.get('/playlist/:id', (req, res) => {
  res.status(501).json({ error: 'Playlists are not supported by ArtistGrid' });
});

app.get('/', (req, res) => {
  const addonUrl = `${req.protocol}://${req.get('host')}/manifest.json`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ArtistGrid Eclipse Addon</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0f0f11;
    color: #e6e6e6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    background: #161618;
    border: 1px solid #2a2a2d;
    border-radius: 12px;
    padding: 20px;
    width: 90%;
    max-width: 520px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.35);
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #ffffff;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .url {
    flex: 1;
    background: #0f0f11;
    border: 1px solid #2a2a2d;
    border-radius: 8px;
    padding: 12px 14px;
    color: #e6e6e6;
    font-size: 14px;
    outline: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy {
    background: #2a2a2d;
    color: #ffffff;
    border: 1px solid #3a3a3d;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 500;
  }
  .copy:hover { background: #353538; }
  .hint {
    margin-top: 12px;
    font-size: 12px;
    color: #8a8a8e;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="title">ArtistGrid Eclipse Addon</div>
    <div class="row">
      <input class="url" id="addonUrl" value="${addonUrl.replace(/"/g, '&quot;')}" readonly />
      <button class="copy" id="copyBtn">Copy</button>
    </div>
    <div class="hint">Paste this URL into Eclipse to install the addon.</div>
  </div>
  <script>
    const input = document.getElementById('addonUrl');
    const btn = document.getElementById('copyBtn');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      } catch {
        input.select();
        document.execCommand('copy');
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      }
    });
  </script>
</body>
</html>`;

  res.set('Content-Type', 'text/html;charset=UTF-8');
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArtistGrid Eclipse addon running on http://localhost:${PORT}`);
});
