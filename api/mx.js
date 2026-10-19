// Vercel serverless API: MX Player TV show/episode resolver.
// Usage:
//   /api/mx?id=306118&s=1&e=1
//   /api/mx?query=Arafta&s=1&e=1
//   /api/mx?id=112888&s=1
//
// This function uses ordinary HTTPS fetch requests. It reports Cloudflare
// challenge pages as diagnostics; it does not attempt to bypass CAPTCHA or
// anti-bot challenges. Configure TMDB_API_KEY in Vercel Environment Variables.

const MX_SEARCH_API = "https://api.mxplayer.in/v1/web/search/resultv2";
const MX_SEARCH_FALLBACK_API = "https://api.mxplayer.in/v1/search/result";
const MX_COLLECTION_API = "https://api.mxplayer.in/v1/web/detail/collection";
const MX_EPISODES_API = "https://api.mxplayer.in/v1/web/detail/tab/tvshowepisodes";
const MX_CLOUDFRONT_BASE = "https://d3sgzbosmwirao.cloudfront.net/";
const DEFAULT_TIMEOUT_MS = 10000;

// Vercel instances may be reused, but this cache is not durable or shared.
const memoryCache = globalThis.__mxResolverCache || (globalThis.__mxResolverCache = new Map());

const knownShows = {
  "112888": {
    title: "True Beauty",
    show_id: "2d359993838e7e16907f1d30ffa5fe60",
    seasons: { 1: "bdc896c545c3f534eb1ec1c593ed2f43" }
  },
  "212204": {
    title: "Twinkling Watermelon",
    show_id: "d390c2c5b452127532ab1d5ab6b96947",
    seasons: { 1: "ce1874d1b6a9da1597597950b79b7274" }
  },
  "230923": {
    title: "Lovely Runner",
    show_id: "04fa9097dfa1c58775adb0b6e92660f9",
    seasons: { 1: "8573785ed4020f920c274a6e9c5e8b17" }
  },
  "306118": {
    title: "Arafta",
    show_id: "8b7dfc61354e9550aa1013f806ddef42",
    seasons: {
      1: "f760e031ad8388ec35a0ddb1a7fe70cb",
      2: "d18e96b9f4e9d1b302a7b43c17bccaeb"
    }
  }
};

function cacheGet(key, ttlMs) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > ttlMs) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(key, value) {
  memoryCache.set(key, { time: Date.now(), value });
  // Keep memory bounded on warm Vercel instances.
  if (memoryCache.size > 300) {
    const first = memoryCache.keys().next().value;
    memoryCache.delete(first);
  }
}
const sidKey = (id, season) => `sid:${id}:${season}`;
const episodeKey = (seasonId) => `episodes:${seasonId}`;

function makeCdnUrl(path) {
  if (!path) return "";
  const value = String(path).trim();
  if (/^https?:\/\//i.test(value)) return value;
  return MX_CLOUDFRONT_BASE.replace(/\/+$/, "") + "/" + value.replace(/^\/+/, "");
}

function isChallengeResponse(status, body, headers) {
  const server = (headers?.get("server") || "").toLowerCase();
  const ray = headers?.get("cf-ray");
  return /<title>\s*(just a moment|attention required|checking your browser|please wait)/i.test(body)
    || /cf-chl-|challenge-platform|challenges\.cloudflare\.com/i.test(body)
    || (status === 403 && (server.includes("cloudflare") || !!ray) && !body.trim().startsWith("{"));
}

async function requestJson(url, options = {}, debug = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeout || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    "Referer": "https://www.mxplayer.in/",
    "Origin": "https://www.mxplayer.in",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    ...(options.headers || {})
  };

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.method === "POST" ? (options.body ?? "{}") : undefined,
      redirect: "follow",
      signal: controller.signal
    });
    const body = await response.text();
    const challenge = isChallengeResponse(response.status, body, response.headers);
    debug.requests ||= [];
    debug.requests.push({
      url,
      status: response.status,
      ok: response.ok,
      challenge_detected: challenge,
      content_type: response.headers.get("content-type") || "",
      cf_ray: response.headers.get("cf-ray") || null
    });
    if (challenge) {
      const error = new Error("Upstream returned a Cloudflare challenge page; this API does not bypass it.");
      error.code = "UPSTREAM_CHALLENGE";
      error.status = response.status || 403;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Upstream HTTP ${response.status}`);
      error.code = "UPSTREAM_HTTP_ERROR";
      error.status = response.status;
      error.bodyPreview = body.slice(0, 300);
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.code = "UPSTREAM_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonData(url, options, debug) {
  const body = await requestJson(url, options, debug);
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Upstream returned non-JSON content");
    error.code = "UPSTREAM_NON_JSON";
    error.bodyPreview = body.slice(0, 300);
    throw error;
  }
}

async function resolveTmdbTitle(id, debug) {
  if (/^[a-f0-9]{32}$/i.test(id)) return "";
  const knownTitles = {
    "112888": "True Beauty",
    "212204": "Twinkling Watermelon",
    "230923": "Lovely Runner",
    "306118": "Arafta"
  };
  if (knownTitles[id]) {
    debug.tmdb_source = "known_title_map";
    return knownTitles[id];
  }
  if (!/^\d+$/.test(id)) {
    debug.tmdb_source = "literal_title";
    return id;
  }
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    debug.tmdb_warning = "TMDB_API_KEY is not configured; using the numeric ID as a search term.";
    return id;
  }
  const url = `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}&language=en-US`;
  debug.tmdb_url = url.replace(key, "[REDACTED]");
  try {
    const data = await requestJsonData(url, { headers: { Accept: "application/json" }, timeout: 7000 }, debug);
    const title = data.name || data.title || data.original_name || "";
    if (title) {
      debug.tmdb_title = title;
      return String(title);
    }
  } catch (error) {
    debug.tmdb_error = error.message;
  }
  return id;
}

function cleanSearchQueries(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const noParens = raw.replace(/\s*[\(\[].*?[\)\]]/g, "").trim();
  const baseName = (noParens.split(/[:\-]/)[0] || "").trim();
  const cleaned = baseName.replace(/\b(season|s|episode|ep|hindi|dubbed|\d{4})\b/ig, "").trim();
  return [...new Set([cleaned, baseName, noParens, raw].filter(Boolean))];
}

async function searchMxShow(name, debug) {
  for (const query of cleanSearchQueries(name)) {
    const postUrl = `${MX_SEARCH_API}?query=${encodeURIComponent(query)}&device-density=2&platform=com.mxplay.desktop`;
    let data;
    try {
      data = await requestJsonData(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }, debug);
    } catch (error) {
      debug.search_post_error = error.message;
      try {
        data = await requestJsonData(`${MX_SEARCH_FALLBACK_API}?query=${encodeURIComponent(query)}`, {}, debug);
      } catch (fallbackError) {
        debug.search_get_error = fallbackError.message;
        continue;
      }
    }

    const sections = Array.isArray(data.sections) ? data.sections : [];
    const candidateShows = [];
    for (const section of sections) {
      const secId = String(section.id || section.name || "").toLowerCase();
      if (secId.includes("show") || secId.includes("tv")) {
        for (const item of section.items || []) {
          if (item.type === "tvshow") {
            if (String(item.title || "").trim().toLowerCase() === query.trim().toLowerCase()) return item;
            candidateShows.push(item);
          }
        }
      }
    }
    if (candidateShows[0]) return candidateShows[0];
    for (const section of sections) {
      const item = (section.items || []).find((entry) => entry.type === "tvshow");
      if (item) return item;
    }
  }
  return null;
}

async function getMxCollection(showId, debug) {
  const url = `${MX_COLLECTION_API}?type=tvshow&id=${encodeURIComponent(showId)}&device-density=2&platform=com.mxplay.desktop`;
  return requestJsonData(url, {}, debug);
}

function walkFind(obj, predicate, result = []) {
  if (!obj || typeof obj !== "object") return result;
  if (!Array.isArray(obj) && predicate(obj)) result.push(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walkFind(value, predicate, result);
  }
  return result;
}
function findSeasons(obj) {
  return walkFind(obj, (item) => item.type === "season" && item.id);
}
function findEpisodes(obj) {
  return walkFind(obj, (item) => item.type === "episode" && item.id);
}
function uniqueById(items) {
  const map = new Map();
  for (const item of items || []) if (item && item.id) map.set(String(item.id), item);
  return [...map.values()];
}
function getEpisodeNumber(ep) {
  for (const key of ["episodeNumber", "episode_number", "episodeNo", "episode", "sequence"]) {
    if (ep?.[key] != null && Number.isFinite(Number(ep[key])) && Number(ep[key]) > 0) return Number(ep[key]);
  }
  const match = String(ep?.title || "").match(/\b(?:episode|ep\.?|e)\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

async function resolveSeasonId(id, season, debug) {
  const known = knownShows[id];
  if (known) {
    debug.source = "known_canonical_map";
    debug.show_title = known.title;
    debug.mx_show_id = known.show_id;
    return { seasonId: known.seasons[season] || null, showId: known.show_id, title: known.title };
  }

  const cached = cacheGet(sidKey(id, season), 7 * 86400 * 1000);
  if (cached) {
    debug.season_cache = "hit";
    return cached;
  }

  let title = await resolveTmdbTitle(id, debug);
  if (!title) title = id;
  let show = null;
  try {
    show = await searchMxShow(title, debug);
  } catch (error) {
    debug.search_error = error.message;
    throw error;
  }
  if (!show?.id) return { seasonId: null, showId: null, title };
  const showId = show.id;
  title = show.title || title;
  debug.mx_show_id = showId;

  let collection;
  try {
    collection = await getMxCollection(showId, debug);
  } catch (error) {
    debug.collection_error = error.message;
    throw error;
  }
  const seasons = uniqueById(findSeasons(collection));
  let seasonId = seasons.find((item) => Number(item.sequence || 0) === season)?.id || seasons[0]?.id || null;
  const result = { seasonId, showId, title };
  if (seasonId) cacheSet(sidKey(id, season), result);
  return result;
}

async function fetchSeasonEpisodes(seasonId, targetEpisode, debug, forceRefresh) {
  const cached = forceRefresh ? null : cacheGet(episodeKey(seasonId), 12 * 3600 * 1000);
  if (cached?.items?.length) {
    const hasTarget = targetEpisode == null || cached.items.some((ep) => getEpisodeNumber(ep) === targetEpisode);
    if (hasTarget || cached.is_complete) {
      debug.episodes_cache = "hit";
      return cached;
    }
    debug.episodes_cache = "partial_cache_refresh";
  }

  let sortOrder = targetEpisode != null && targetEpisode >= 15 ? 1 : 0;
  let baseUrl = `${MX_EPISODES_API}?type=season&id=${encodeURIComponent(seasonId)}&sortOrder=${sortOrder}&device-density=2&platform=com.mxplay.desktop`;
  debug.mx_episodes_api = baseUrl;
  const allEpisodes = cached?.items ? [...cached.items] : [];
  let baseData = cached || null;
  let reachedEnd = false;
  let currentUrl = baseUrl;
  let pages = targetEpisode != null ? 6 : 30;

  while (currentUrl && pages > 0) {
    let pageData;
    try {
      pageData = await requestJsonData(currentUrl, {}, debug);
    } catch (error) {
      debug.episodes_error = error.message;
      if (sortOrder === 1 && currentUrl === baseUrl) {
        sortOrder = 0;
        baseUrl = `${MX_EPISODES_API}?type=season&id=${encodeURIComponent(seasonId)}&sortOrder=0&device-density=2&platform=com.mxplay.desktop`;
        currentUrl = baseUrl;
        continue;
      }
      break;
    }
    if (!baseData) baseData = pageData;
    let items = Array.isArray(pageData.items) ? pageData.items : [];
    if (!items.length) items = findEpisodes(pageData);
    if (!items.length) {
      reachedEnd = true;
      break;
    }

    let foundTarget = false;
    for (const original of items) {
      const item = { ...original };
      const streamHigh = item?.stream?.hls?.high || item?.stream?.hls?.base || item?.stream?.mxplay?.hls?.high || "";
      item.m3u8 = makeCdnUrl(streamHigh);
      allEpisodes.push(item);
      if (targetEpisode != null && getEpisodeNumber(item) === targetEpisode) foundTarget = true;
    }
    if (foundTarget) break;

    const next = pageData.next;
    if (typeof next === "string" && next) {
      currentUrl = `${baseUrl}&${next.replace(/^[?&]/, "")}`;
      pages--;
    } else {
      reachedEnd = true;
      break;
    }
  }

  if (!baseData && !allEpisodes.length) return null;
  baseData ||= { items: [] };
  const items = uniqueById(allEpisodes).sort((a, b) => (getEpisodeNumber(a) || 0) - (getEpisodeNumber(b) || 0));
  const result = { ...baseData, items, totalEpisodes: items.length, is_complete: reachedEnd };
  cacheSet(episodeKey(seasonId), result);
  return result;
}

function parseParams(req) {
  const q = req.query || {};
  let id = String(q.id || q.tmdb_id || q.query || q.title || q.name || "").trim();
  let season = Math.max(1, parseInt(q.s || q.season || "1", 10) || 1);
  let episodeValue = q.e ?? q.episode ?? q.ep;
  let episode = episodeValue == null || episodeValue === "" ? null : Math.max(1, parseInt(String(episodeValue), 10) || 1);
  let type = String(q.type || "tv");
  if (!id) {
    const path = String(req.url || "").split("?")[0];
    const match = path.match(/(?:mx|tv|movie)\/([a-f0-9]{32}|\d{3,8})(?:\/(\d+))?(?:\/(\d+))?/i);
    if (match) {
      id = match[1];
      season = Math.max(1, parseInt(match[2] || "1", 10));
      episode = match[3] ? Math.max(1, parseInt(match[3], 10)) : null;
    }
  }
  return { id: id || "112888", season, episode, type };
}

function send(res, status, body) {
  res.status(status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return res.json(body);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET") return send(res, 405, { success: false, error: "Method not allowed; use GET." });

  const params = parseParams(req);
  const { id, season, episode, type } = params;
  const debugMode = ["1", "true", "yes"].includes(String(req.query.debug || "").toLowerCase());
  const debug = { id, season, episode, type };

  try {
    if (/^[a-f0-9]{32}$/i.test(id)) {
      debug.source = "season_id";
      const seasonData = await fetchSeasonEpisodes(id, episode, debug, Boolean(req.query.nocache || req.query.refresh || req.query.clear));
      if (!seasonData?.items?.length) return send(res, 502, {
        success: false, error: "Could not retrieve episodes for this season ID.",
        diagnostic: debug.episodes_error || "Upstream returned no episodes.", debug: debugMode ? debug : undefined
      });
      return sendEpisodeResult(res, seasonData, { id, season, episode }, debug, debugMode);
    }

    const resolved = await resolveSeasonId(id, season, debug);
    if (!resolved.seasonId) return send(res, 404, {
      success: false,
      error: "Could not find an MX Player season ID for this show.",
      diagnostic: debug.search_error || debug.collection_error || "No matching season was found.",
      title: resolved.title,
      season,
      debug: debugMode ? debug : undefined
    });

    debug.season_id = resolved.seasonId;
    const seasonData = await fetchSeasonEpisodes(resolved.seasonId, episode, debug, Boolean(req.query.nocache || req.query.refresh || req.query.clear));
    if (!seasonData?.items?.length) return send(res, 502, {
      success: false,
      error: "MX Player episode request failed.",
      diagnostic: debug.episodes_error || "Upstream returned an empty episode list.",
      title: resolved.title,
      season,
      season_id: resolved.seasonId,
      debug: debugMode ? debug : undefined
    });

    return sendEpisodeResult(res, seasonData, { id, season, episode, title: resolved.title, seasonId: resolved.seasonId }, debug, debugMode);
  } catch (error) {
    const status = error.code === "UPSTREAM_CHALLENGE" ? 502 :
      error.code === "UPSTREAM_TIMEOUT" ? 504 :
      error.status >= 400 && error.status < 600 ? error.status : 502;
    return send(res, status, {
      success: false,
      error: error.message || "Unexpected resolver error.",
      code: error.code || "RESOLVER_ERROR",
      diagnostic: error.bodyPreview || error.message || "No additional diagnostic.",
      debug: debugMode ? debug : undefined
    });
  }
};

function sendEpisodeResult(res, seasonData, meta, debug, debugMode) {
  const { id, season, episode, title, seasonId } = meta;
  if (episode == null) {
    return send(res, 200, debugMode ? {
      success: true, title: title || "", season, season_id: seasonId || id,
      debug, mx_response: seasonData
    } : seasonData);
  }

  let selected = seasonData.items.find((ep) => getEpisodeNumber(ep) === episode);
  if (!selected && seasonData.items.length && getEpisodeNumber(seasonData.items[0]) === 1) {
    const candidate = seasonData.items[episode - 1];
    if (candidate && (getEpisodeNumber(candidate) == null || getEpisodeNumber(candidate) === episode)) selected = candidate;
  }
  if (!selected) return send(res, 404, {
    success: false,
    error: `Episode ${episode} not found in Season ${season}.`,
    title: title || "",
    season,
    season_id: seasonId || id,
    total_episodes: seasonData.items.length,
    debug: debugMode ? debug : undefined
  });

  const episodeId = selected.id;
  const hls = selected?.stream?.hls || {};
  const hlsUrls = {};
  for (const quality of ["high", "base", "main"]) {
    if (hls[quality]) hlsUrls[quality] = makeCdnUrl(hls[quality]);
  }
  const result = {
    ...selected,
    hls_urls: hlsUrls,
    m3u8: selected.m3u8 || hlsUrls.high || hlsUrls.base || hlsUrls.main || "",
    official_url: `https://www.mxplayer.in/detail/tvshow_episode/${episodeId}`,
    show_title: title || selected?.container?.container?.title || selected?.container?.title || selected?.show?.title || "",
    season,
    episode
  };
  if (debugMode) return send(res, 200, {
    success: true, show: result.show_title, season, season_id: seasonId || id,
    episode, episode_id: episodeId, official_url: result.official_url,
    m3u8: result.m3u8, hls_urls: hlsUrls, debug, episode_data: result
  });
  return send(res, 200, result);
}
