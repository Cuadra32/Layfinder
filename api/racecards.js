/**
 * Smart racecards extraction endpoint.
 * Fetches Racing Post racecards and returns structured JSON.
 * Handles __NEXT_DATA__, self.__next_f.push() (RSC), and raw HTML parsing.
 */

/**
 * UK courses that host flat racing — exact Racing Post URL slugs.
 * Used for whitelist matching: the slug from the URL must be in this set.
 */
const UK_FLAT_SLUGS = new Set([
  'ascot','ayr','bath','beverley','brighton','carlisle',
  'catterick','catterick-bridge',
  'chelmsford','chelmsford-city',
  'chepstow','chester','doncaster',
  'epsom','epsom-downs',
  'ffos-las','goodwood',
  'great-yarmouth','yarmouth',
  'hamilton','hamilton-park',
  'haydock','haydock-park',
  'kempton','kempton-park',
  'leicester',
  'lingfield','lingfield-park',
  'musselburgh','newbury','newcastle','newmarket',
  'nottingham','pontefract','redcar','ripon','salisbury',
  'sandown','sandown-park',
  'southwell','thirsk','wetherby','windsor',
  'wolverhampton','york'
]);

/**
 * UK flat course names (space-separated) for matching extracted data.
 * Course names from JSON data get normalized and checked against this set.
 */
const UK_FLAT_NAMES = new Set([
  'ascot','ayr','bath','beverley','brighton','carlisle',
  'catterick','catterick bridge',
  'chelmsford','chelmsford city',
  'chepstow','chester','doncaster',
  'epsom','epsom downs',
  'ffos las','goodwood',
  'great yarmouth','yarmouth',
  'hamilton','hamilton park',
  'haydock','haydock park',
  'kempton','kempton park',
  'leicester',
  'lingfield','lingfield park',
  'musselburgh','newbury','newcastle','newmarket',
  'nottingham','pontefract','redcar','ripon','salisbury',
  'sandown','sandown park',
  'southwell','thirsk','wetherby','windsor',
  'wolverhampton','york'
]);

const JUMP_RE = /chase|chs|hurdle|hdl|nh\s?flat|nhf|bumper|steeplechase|national hunt/i;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity'
};

/* ── URL extraction ─────────────────────────────── */

function findRaceUrls(html) {
  const urls = new Map(); // href → { href, courseSlug, courseId, date, raceId }

  // Unescape all JS-escaped slashes so regex works on RSC payloads
  const clean = html.replace(/\\+\//g, '/');

  // Pattern: /racecards/{courseId}/{courseSlug}/{date}/{raceId}
  const re = /\/racecards\/(\d+)\/([a-z][a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const href = m[0];
    if (!urls.has(href)) {
      urls.set(href, {
        href,
        courseId: m[1],
        courseSlug: m[2],
        date: m[3],
        raceId: m[4],
        courseName: m[2].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      });
    }
  }

  return Array.from(urls.values());
}

/**
 * Check if a Racing Post URL slug is a UK flat course.
 * Uses EXACT slug matching — no substring tricks.
 */
function isUKFlat(slug) {
  return UK_FLAT_SLUGS.has(slug.toLowerCase());
}

/**
 * Check if a course name (from extracted JSON data) matches a UK flat course.
 * Normalizes the name and checks against the known UK flat names set.
 */
function isUKFlatCourseName(name) {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  // Direct match
  if (UK_FLAT_NAMES.has(n)) return true;
  // Try without common suffixes like "(AW)" or extra text
  const cleaned = n.replace(/\s*\(aw\)|\s*\(turf\)|\s*racecourse/gi, '').trim();
  if (UK_FLAT_NAMES.has(cleaned)) return true;
  // Check if any UK name matches the start of the course name
  // e.g. "Haydock Park Racecourse" should match "haydock park"
  for (const uk of UK_FLAT_NAMES) {
    if (cleaned === uk || cleaned.startsWith(uk + ' ')) return true;
  }
  return false;
}

/**
 * Check if a race description indicates jump racing (not flat).
 */
function isJumpRace(desc) {
  return JUMP_RE.test(desc || '');
}

/* ── JSON extraction from HTML ──────────────────── */

function extractAllJSON(html) {
  const objects = [];

  // 1. __NEXT_DATA__
  const nextDataRe = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
  const ndm = html.match(nextDataRe);
  if (ndm) {
    try { objects.push({ source: '__NEXT_DATA__', data: JSON.parse(ndm[1]) }); } catch (e) {}
  }

  // 2. self.__next_f.push() RSC payloads
  const pushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
  let pm;
  let rscText = '';
  while ((pm = pushRe.exec(html)) !== null) {
    let unescaped;
    try {
      unescaped = JSON.parse('"' + pm[2] + '"');
    } catch (e) {
      unescaped = pm[2]
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
    }
    rscText += unescaped + '\n';
  }

  if (rscText) {
    // Parse RSC line format: N:data
    const lines = rscText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 0 || colonIdx > 6) continue;
      const prefix = trimmed.substring(0, colonIdx);
      if (!/^[\da-fA-F]+$/.test(prefix)) continue;
      const data = trimmed.substring(colonIdx + 1);
      if (data.length > 2 && (data[0] === '{' || data[0] === '[')) {
        try {
          const parsed = JSON.parse(data);
          objects.push({ source: 'RSC:' + prefix, data: parsed });
        } catch (e) {
          // Try to extract nested JSON objects from RSC element arrays
          if (data[0] === '[') {
            try {
              const arr = JSON.parse(data);
              walkRSCArray(arr, objects, 'RSC-elem:' + prefix);
            } catch (e2) {}
          }
        }
      }
    }
  }

  // 3. window.xxx = {...} patterns
  const windowRe = /window\[?"?([A-Za-z_]\w*)"?\]?\s*=\s*(\{[\s\S]+?\})\s*;/g;
  let wm;
  while ((wm = windowRe.exec(html)) !== null) {
    try { objects.push({ source: 'window.' + wm[1], data: JSON.parse(wm[2]) }); } catch (e) {}
  }

  return { objects, rscText };
}

function walkRSCArray(arr, results, source, depth) {
  if (!Array.isArray(arr) || (depth || 0) > 6) return;
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      results.push({ source, data: item });
    }
    if (Array.isArray(item)) {
      walkRSCArray(item, results, source, (depth || 0) + 1);
    }
  }
}

/* ── Runner extraction from JSON ────────────────── */

function looksLikeRunners(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return false;
  // Check first 3 items
  let hits = 0;
  const signals = ['horse','name','runner','silk','jockey','trainer','saddlecloth',
    'saddle','draw','form','odds','cloth','number','uid','runnerid','horseid',
    'horsename','runnername','formfigures','saddleclothnumber'];
  for (let i = 0; i < Math.min(arr.length, 3); i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') return false;
    const keys = Object.keys(item).map(k => k.toLowerCase());
    let itemHits = 0;
    for (const sig of signals) {
      if (keys.some(k => k.includes(sig))) itemHits++;
    }
    if (itemHits >= 2) hits++;
  }
  return hits >= 1;
}

function findAllRunnerArrays(obj, depth, parentInfo, results) {
  results = results || [];
  if (!obj || typeof obj !== 'object') return results;
  depth = depth || 0;
  if (depth > 15) return results;

  const ri = gatherRaceInfo(obj);
  const merged = { ...parentInfo, ...Object.fromEntries(Object.entries(ri).filter(([, v]) => v)) };

  // Check named keys for runner arrays
  const arrKeys = ['runners','horses','Runners','Horses','cards','entries',
    'runnersData','horseList','raceRunners','participants','starters','selections',
    'runners_list','racecard','runnerList'];
  let foundHere = false;
  for (const k of arrKeys) {
    const v = obj[k];
    if (Array.isArray(v) && v.length >= 2 && v[0] && typeof v[0] === 'object') {
      if (looksLikeRunners(v)) {
        results.push({ runners: v, raceInfo: merged });
        foundHere = true;
        break;
      }
    }
  }

  // Check all keys for unnamed runner arrays
  if (!foundHere) {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length >= 2 && v[0] && typeof v[0] === 'object') {
        if (looksLikeRunners(v)) {
          results.push({ runners: v, raceInfo: merged });
          foundHere = true;
          break;
        }
      }
    }
  }

  if (foundHere) return results;

  // Recurse into children
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') {
          findAllRunnerArrays(item, depth + 1, merged, results);
        }
      }
    } else if (v && typeof v === 'object') {
      findAllRunnerArrays(v, depth + 1, merged, results);
    }
  }

  return results;
}

function gatherRaceInfo(obj) {
  const ri = {};
  if (!obj || typeof obj !== 'object') return ri;

  const cKeys = ['raceCourse','courseName','course','venue','venueName','meetingName',
    'course_name','meeting','courseFull','racecourse','track','trackName','meeting_name'];
  for (const k of cKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 1) { ri.course = v; break; }
    if (v && typeof v === 'object') {
      const n = v.name || v.courseName || v.displayName || v.venueName;
      if (n) { ri.course = n; break; }
      // Also check for country inside course object
      const cc = v.countryCode || v.country || v.region || v.regionCode;
      if (cc) ri.country = String(cc).toUpperCase();
    }
  }

  // Extract country/region if available
  const countryKeys = ['countryCode','country','region','regionCode','meetingRegion',
    'courseCountry','venueCountry','courseRegion','raceRegion','meetingCountry'];
  if (!ri.country) {
    for (const k of countryKeys) {
      const v = obj[k];
      if (typeof v === 'string' && v.length >= 2 && v.length <= 5) {
        ri.country = v.toUpperCase(); break;
      }
    }
  }

  const tKeys = ['raceTime','time','offTime','off_time','raceDateTime','startTime',
    'scheduled_time','race_time','off','postTime'];
  for (const k of tKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v) {
      const tm = v.match(/(\d{1,2})[:.]\s?(\d{2})/);
      if (tm) { ri.time = tm[1] + ':' + tm[2]; break; }
      if (v.length <= 5 && /^\d/.test(v)) { ri.time = v; break; }
    }
  }

  const dKeys = ['raceTitle','raceName','title','name','race_name','description',
    'raceClass','race_title','subtitle','raceType'];
  for (const k of dKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 3 && v.length < 120) {
      if (/race|stake|handicap|maiden|novice|class|mile|furlong|nursery|cup|trophy|plate|sprint|[0-9]+[mf]/i.test(v)) {
        ri.desc = v; break;
      }
    }
  }

  return ri;
}

function extractRunner(r) {
  // Name
  let name = '';
  const nameKeys = ['horseName','horse_name','horseStyleName','horseFull',
    'horse','name','runnerName','runner_name','runner','displayName'];
  for (const k of nameKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 1) { name = v; break; }
    if (v && typeof v === 'object') {
      name = v.horseName || v.name || v.horse_name || v.displayName || '';
      if (name) break;
    }
  }

  // Odds
  let oddsStr = '', oddsDec = null;
  const oddsKeys = ['odds','bestOdds','best_odds','industryBestOdds','forecastPrice',
    'forecast_price','spOdds','sp','startingPrice','price','bestOffer',
    'oddsDecimal','decimalOdds','fractionalOdds','rpOdds','currentOdds','liveOdds'];
  for (const k of oddsKeys) {
    const v = r[k];
    if (!v) continue;
    if (typeof v === 'number' && v > 1 && v < 200) {
      oddsDec = v; oddsStr = decToFrac(v); break;
    }
    if (typeof v === 'string') {
      const fd = fracToDec(v);
      if (fd) { oddsDec = fd; oddsStr = v; break; }
      const pd = parseFloat(v);
      if (!isNaN(pd) && pd > 1 && pd < 200) { oddsDec = pd; oddsStr = decToFrac(pd); break; }
    }
    if (typeof v === 'object' && v) {
      const nd = v.decimal || v.dec || v.decimalOdds || v.price || v.decimalPrice;
      const nf = v.fractional || v.frac || v.fractionalOdds || v.display || v.fractionalPrice;
      if (typeof nd === 'number' && nd > 1) { oddsDec = nd; oddsStr = nf || decToFrac(nd); break; }
      if (typeof nf === 'string') { oddsDec = fracToDec(nf); oddsStr = nf; break; }
      if (v.numerator !== undefined && v.denominator && v.denominator > 0) {
        oddsDec = (v.numerator / v.denominator) + 1;
        oddsStr = v.numerator + '/' + v.denominator;
        break;
      }
    }
  }

  // Form
  let form = '';
  const formKeys = ['form','formFigures','recentForm','form_figures','recent_form',
    'formFig','formGuide','last_form','raceForm','formString','formWatch',
    'formatedForm','formattedForm','pastForm','lifetimeForm'];
  for (const k of formKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length >= 1 && /[0-9FPURSCBO]/i.test(v)) {
      // Skip if it looks like fractional odds
      if (/^\d{1,3}\/\d{1,3}$/.test(v)) continue;
      form = v; break;
    }
    if (Array.isArray(v)) {
      form = v.map(f => {
        if (typeof f === 'object' && f) return f.position || f.pos || f.finishPosition || '';
        return String(f);
      }).join('');
      if (form) break;
    }
    if (v && typeof v === 'object') {
      form = v.figures || v.form || v.recent || v.flat || v.last6 || '';
      if (form) break;
    }
  }

  // Trainer
  let trainer = '', trainerPct = null;
  const trainerKeys = ['trainerName','trainer_name','trainer','trainerStyleName',
    'trainerFull','jockeyTrainer'];
  for (const k of trainerKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 1) { trainer = v; break; }
    if (v && typeof v === 'object') {
      trainer = v.name || v.trainerName || v.styleName || v.displayName || v.trainer_name || '';
      if (v.percent !== undefined) trainerPct = parseFloat(v.percent);
      if (v.strikeRate !== undefined) trainerPct = parseFloat(v.strikeRate);
      if (v.winPercent !== undefined) trainerPct = parseFloat(v.winPercent);
      if (v.stats) {
        if (v.stats.percent !== undefined) trainerPct = parseFloat(v.stats.percent);
        if (v.stats.wins !== undefined && v.stats.runs > 0) {
          trainerPct = Math.round((v.stats.wins / v.stats.runs) * 100);
        }
      }
      if (v.last14Days && v.last14Days.runs > 0) {
        trainerPct = Math.round((v.last14Days.wins / v.last14Days.runs) * 100);
      }
      if (trainer) break;
    }
  }

  // Trainer strike rate from separate fields
  if (trainerPct === null) {
    const tsrKeys = ['trainerStrikeRate','trainer_strike_rate','trainerPercent',
      'trainerWinRate','trainerWinPercent','trainerSr'];
    for (const k of tsrKeys) {
      if (r[k] !== undefined) { trainerPct = parseFloat(r[k]); break; }
    }
  }
  if (trainerPct === null) {
    const statKeys = ['trainerLast14','trainerLast14Days','trainerForm','trainerStats',
      'trainerRecord'];
    for (const k of statKeys) {
      const v = r[k];
      if (v && typeof v === 'object' && v.runs > 0 && v.wins !== undefined) {
        trainerPct = Math.round((v.wins / v.runs) * 100); break;
      }
    }
  }
  // Extract % from trainer name string
  if (trainerPct === null && typeof trainer === 'string') {
    const pctM = trainer.match(/(\d{1,3})%/);
    if (pctM) trainerPct = parseInt(pctM[1]);
  }

  return { name, form, odds: oddsStr, oddsDecimal: oddsDec, trainer, trainerPct };
}

function decToFrac(d) {
  if (!d || d <= 1) return 'EVS';
  const n = d - 1;
  const tbl = [[1,5],[1,4],[1,3],[2,5],[1,2],[4,7],[8,13],[4,6],[8,11],[4,5],[5,6],
    [10,11],[1,1],[6,5],[5,4],[11,8],[6,4],[13,8],[7,4],[2,1],[9,4],[5,2],
    [11,4],[3,1],[7,2],[4,1],[9,2],[5,1],[6,1],[7,1],[8,1]];
  let best = null, bd = 99;
  for (const f of tbl) {
    const diff = Math.abs(f[0] / f[1] - n);
    if (diff < bd) { bd = diff; best = f; }
  }
  return best ? best[0] + '/' + best[1] : d.toFixed(1);
}

function fracToDec(s) {
  if (!s) return null;
  if (/^evs?$/i.test(s.trim())) return 2.0;
  const m = s.match(/(\d+)\/(\d+)/);
  if (!m) return null;
  return (+m[1] / +m[2]) + 1;
}

/* ── Main handler ───────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const debug = [];
  const startTime = Date.now();

  try {
    // ── Step 1: Fetch the racecards index page ──
    const indexResp = await fetch('https://www.racingpost.com/racecards/', {
      headers: FETCH_HEADERS,
      redirect: 'follow'
    });

    if (!indexResp.ok) {
      return res.status(502).json({
        error: 'Racing Post returned HTTP ' + indexResp.status,
        debug
      });
    }

    const html = await indexResp.text();
    debug.push({
      step: 'fetched_index',
      htmlLength: html.length,
      elapsed: Date.now() - startTime
    });

    // ── Step 2: Try to extract races directly from index page data ──
    const { objects: jsonObjects, rscText } = extractAllJSON(html);
    debug.push({
      step: 'extracted_json',
      objectCount: jsonObjects.length,
      rscTextLength: rscText.length,
      sources: jsonObjects.slice(0, 10).map(o => o.source)
    });

    // Search JSON objects for runner arrays
    let directRaces = [];
    const seenKeys = new Set();

    for (const { source, data } of jsonObjects) {
      const found = findAllRunnerArrays(data);
      for (const { runners, raceInfo } of found) {
        const horses = runners.map(r => extractRunner(r)).filter(h => h.name);
        if (horses.length < 2) continue;

        // Dedup by horse name set
        const key = horses.map(h => h.name.toLowerCase()).sort().join('|');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        directRaces.push({
          course: raceInfo.course || '',
          time: raceInfo.time || '',
          desc: raceInfo.desc || '',
          country: raceInfo.country || '',
          horses,
          source
        });
      }
    }

    debug.push({
      step: 'direct_extraction',
      racesFound: directRaces.length,
      elapsed: Date.now() - startTime
    });

    // ── Step 3: Find race URLs ──
    const allRaceUrls = findRaceUrls(html);
    const ukFlatUrls = allRaceUrls.filter(r => isUKFlat(r.courseSlug));

    // Deduplicate by raceId
    const seenRaceIds = new Set();
    const uniqueUkFlatUrls = ukFlatUrls.filter(r => {
      if (seenRaceIds.has(r.raceId)) return false;
      seenRaceIds.add(r.raceId);
      return true;
    });

    debug.push({
      step: 'found_urls',
      total: allRaceUrls.length,
      ukFlat: uniqueUkFlatUrls.length,
      allSlugs: [...new Set(allRaceUrls.map(r => r.courseSlug))],
      ukFlatSlugs: [...new Set(uniqueUkFlatUrls.map(r => r.courseSlug))],
      elapsed: Date.now() - startTime
    });

    // If we got good direct results, filter and return them
    if (directRaces.length >= 5) {
      // Filter for UK flat — require positive identification, never keep unknowns
      directRaces = directRaces.filter(r => {
        // Must have a course name — unknown courses are NOT kept
        if (!r.course) return false;

        // If country data is available, use it
        if (r.country) {
          const cc = r.country.toUpperCase();
          // Only accept GB/UK — reject IRE, AUS, FR, USA, etc.
          if (cc !== 'GB' && cc !== 'UK' && cc !== 'GBR') return false;
        }

        // Course name must match a known UK flat course (exact, not substring)
        if (!isUKFlatCourseName(r.course)) return false;

        // Must not be a jump race
        if (isJumpRace(r.desc)) return false;

        return true;
      });

      return res.status(200).json({
        races: directRaces,
        method: 'direct',
        debug
      });
    }

    // ── Step 4: Fetch individual race pages ──
    if (!uniqueUkFlatUrls.length) {
      // If we have some direct races, return them
      if (directRaces.length) {
        return res.status(200).json({
          races: directRaces,
          method: 'direct_partial',
          debug
        });
      }

      // Return URLs diagnostic info
      debug.push({
        step: 'no_uk_flat_urls',
        htmlSnippet: html.substring(0, 3000),
        scriptCount: (html.match(/<script/gi) || []).length,
        hasNextData: /__NEXT_DATA__/.test(html),
        hasRSC: /self\.__next_f/.test(html),
        racecardsInText: (html.match(/racecards/gi) || []).length
      });

      return res.status(200).json({
        races: [],
        method: 'none',
        error: 'No UK flat race URLs found on racecards page',
        debug
      });
    }

    // Fetch race pages in parallel batches
    const races = [...directRaces];
    const BATCH_SIZE = 6;
    const MAX_RACES = 30;
    const toFetch = uniqueUkFlatUrls.slice(0, MAX_RACES);

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      // Check timeout (leave 2s buffer for Vercel)
      if (Date.now() - startTime > 8000) {
        debug.push({ step: 'timeout_bail', fetched: i, total: toFetch.length });
        break;
      }

      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (raceUrl) => {
          try {
            const resp = await fetch('https://www.racingpost.com' + raceUrl.href, {
              headers: FETCH_HEADERS,
              redirect: 'follow',
              signal: AbortSignal.timeout(4000)
            });
            if (!resp.ok) return null;
            const raceHtml = await resp.text();
            return { raceUrl, html: raceHtml };
          } catch (e) {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { raceUrl, html: raceHtml } = result.value;

        // Extract data from race page
        const { objects: raceObjects } = extractAllJSON(raceHtml);
        let raceFound = false;

        for (const { source, data } of raceObjects) {
          const found = findAllRunnerArrays(data);
          for (const { runners, raceInfo } of found) {
            const horses = runners.map(r => extractRunner(r)).filter(h => h.name);
            if (horses.length < 2) continue;

            const key = horses.map(h => h.name.toLowerCase()).sort().join('|');
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            // Skip jump races at mixed venues (e.g. Haydock hurdle)
            if (isJumpRace(raceInfo.desc)) continue;

            races.push({
              course: raceInfo.course || raceUrl.courseName || '',
              time: raceInfo.time || '',
              desc: raceInfo.desc || '',
              horses,
              source: 'page:' + raceUrl.courseSlug
            });
            raceFound = true;
          }
        }

        // If JSON extraction failed, try text-based extraction from RSC text
        if (!raceFound) {
          const { rscText: pageRsc } = extractAllJSON(raceHtml);
          if (pageRsc) {
            // Search for form-like and name-like patterns in RSC text
            debug.push({
              step: 'page_rsc_fallback',
              url: raceUrl.courseSlug,
              rscLength: pageRsc.length,
              snippet: pageRsc.substring(0, 500)
            });
          }
        }
      }
    }

    debug.push({
      step: 'fetch_complete',
      totalRaces: races.length,
      elapsed: Date.now() - startTime
    });

    // Sort races by time
    races.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json({
      races,
      method: 'per_race',
      debug
    });

  } catch (err) {
    debug.push({ step: 'error', message: err.message, stack: err.stack });
    return res.status(500).json({
      error: err.message,
      debug
    });
  }
}
