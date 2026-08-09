/**
 * Smart racecards extraction endpoint.
 * Fetches Racing Post racecards and returns structured JSON.
 *
 * Data lives in __NEXT_DATA__ → props.pageProps.initialState:
 *   - raceCards.meetings[].races[] — race metadata with country, raceTypeCode, etc.
 *   - racePage.data — runner data on individual race pages
 *
 * Key fields (from Racing Post):
 *   race.country        = "GB" | "IRE" | "USA" | "FR" | …
 *   race.raceTypeCode   = "F" (flat) | "H" (hurdle) | "C" (chase) | …
 *   race.courseStyleName = "Chepstow" (proper-case course name)
 *   race.raceStart       = "14:30" (HH:MM)
 *   race.raceTitle       = full race description
 *   race.raceUrl         = "/racecards/178/curragh/2026-08-09/926227"
 */

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity'
};

/* ── Runner extraction from JSON ────────────────── */

/** Recursively walk object tree to find arrays that look like runners. */
function findAllRunnerArrays(obj, depth, parentInfo, results) {
  results = results || [];
  if (!obj || typeof obj !== 'object') return results;
  depth = depth || 0;
  if (depth > 15) return results;

  const ri = gatherRaceInfo(obj);
  const merged = { ...parentInfo, ...Object.fromEntries(Object.entries(ri).filter(([, v]) => v)) };

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

  // Course name — Racing Post uses courseStyleName, name, etc.
  const cKeys = ['courseStyleName','raceCourse','courseName','course','venue',
    'venueName','meetingName','course_name','meeting'];
  for (const k of cKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 1) { ri.course = v; break; }
    if (v && typeof v === 'object') {
      const n = v.name || v.courseName || v.displayName || v.venueName;
      if (n) { ri.course = n; break; }
    }
  }

  // Race time — Racing Post uses raceStart
  const tKeys = ['raceStart','raceTime','time','offTime','off_time','raceDateTime',
    'startTime','scheduled_time','race_time','off','postTime'];
  for (const k of tKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v) {
      const tm = v.match(/(\d{1,2})[:.]\s?(\d{2})/);
      if (tm) { ri.time = tm[1] + ':' + tm[2]; break; }
      if (v.length <= 5 && /^\d/.test(v)) { ri.time = v; break; }
    }
  }

  // Race title/description
  const dKeys = ['raceTitle','raceName','title','name','race_name','description',
    'raceClass','race_title','subtitle','raceType'];
  for (const k of dKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 3 && v.length < 200) {
      // Accept race titles (don't require specific keywords — Racing Post titles vary)
      if (k === 'raceTitle' || k === 'raceName' || k === 'race_title') {
        ri.desc = v; break;
      }
      if (/race|stake|handicap|maiden|novice|class|mile|furlong|nursery|cup|trophy|plate|sprint|[0-9]+[mf]/i.test(v)) {
        ri.desc = v; break;
      }
    }
  }

  return ri;
}

function looksLikeRunners(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return false;
  let hits = 0;
  const signals = ['horse','horsename','horsestylename','jockey','jockeyname',
    'jockeystylename','trainer','trainername','trainerstylename',
    'form','formfigures','silk','silkurl','saddlecloth','saddleclothnumber',
    'draw','stall','cloth','odds','rpr','topspeed','officialrating',
    'horseid','runnerid','uid','age','weight','headgear','weightlbs',
    'damsire','sire','dam','owner','ownername'];
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

function extractRunner(r) {
  // Name — Racing Post uses horseStyleName
  let name = '';
  const nameKeys = ['horseStyleName','horseName','horse_name','horseFull',
    'horse','name','runnerName','runner_name','runner','displayName'];
  for (const k of nameKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 1) { name = v; break; }
    if (v && typeof v === 'object') {
      name = v.horseStyleName || v.horseName || v.name || v.displayName || '';
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

  // Form — Racing Post uses formFigures
  let form = '';
  const formKeys = ['formFigures','form','recentForm','form_figures','recent_form',
    'formFig','formGuide','last_form','raceForm','formString','formWatch',
    'formatedForm','formattedForm','pastForm','lifetimeForm'];
  for (const k of formKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length >= 1 && /[0-9FPURSCBO-]/i.test(v)) {
      if (/^\d{1,3}\/\d{1,3}$/.test(v)) continue; // Skip fractional odds
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

  // Trainer — Racing Post uses trainerStyleName
  let trainer = '', trainerPct = null;
  const trainerKeys = ['trainerStyleName','trainerName','trainer_name','trainer',
    'trainerFull','jockeyTrainer'];
  for (const k of trainerKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 1) { trainer = v; break; }
    if (v && typeof v === 'object') {
      trainer = v.trainerStyleName || v.name || v.trainerName || v.styleName || v.displayName || '';
      if (v.percent !== undefined) trainerPct = parseFloat(v.percent);
      if (v.strikeRate !== undefined) trainerPct = parseFloat(v.strikeRate);
      if (v.winPercent !== undefined) trainerPct = parseFloat(v.winPercent);
      if (v.last14Days && v.last14Days.runs > 0) {
        trainerPct = Math.round((v.last14Days.wins / v.last14Days.runs) * 100);
      }
      if (v.stats) {
        if (v.stats.percent !== undefined) trainerPct = parseFloat(v.stats.percent);
        if (v.stats.wins !== undefined && v.stats.runs > 0) {
          trainerPct = Math.round((v.stats.wins / v.stats.runs) * 100);
        }
      }
      if (trainer) break;
    }
  }

  // Trainer strike rate from separate fields
  if (trainerPct === null) {
    const tsrKeys = ['trainerStrikeRate','trainer_strike_rate','trainerPercent',
      'trainerWinRate','trainerWinPercent','trainerSr','trainerLast14',
      'trainerLast14Days','trainerForm','trainerStats','trainerRecord'];
    for (const k of tsrKeys) {
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'number') { trainerPct = v; break; }
      if (typeof v === 'string') { trainerPct = parseFloat(v); break; }
      if (typeof v === 'object' && v.runs > 0 && v.wins !== undefined) {
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

/* ── Extract __NEXT_DATA__ from HTML ──────────────── */

function extractNextData(html) {
  const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
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
        error: 'Racing Post returned HTTP ' + indexResp.status, debug
      });
    }

    const html = await indexResp.text();
    debug.push({ step: 'fetched_index', htmlLength: html.length, elapsed: Date.now() - startTime });

    // ── Step 2: Parse __NEXT_DATA__ for structured race list ──
    const nextData = extractNextData(html);
    if (!nextData) {
      return res.status(200).json({
        races: [], method: 'none', error: 'No __NEXT_DATA__ found on racecards page', debug
      });
    }

    const initialState = nextData.props?.pageProps?.initialState || {};
    const meetings = initialState.raceCards?.meetings || [];

    // ── Step 3: Filter to GB flat races using Racing Post's own fields ──
    const gbFlatRaces = [];
    for (const meeting of meetings) {
      const races = meeting.races || [];
      for (const race of races) {
        // country = "GB" for Great Britain (not IRE, USA, FR, etc.)
        // raceTypeCode = "F" for Flat (not "H" hurdle, "C" chase, etc.)
        if (race.country === 'GB' && race.raceTypeCode === 'F') {
          gbFlatRaces.push({
            raceId: race.raceId,
            course: race.courseStyleName || race.name || '',
            time: race.raceStart || '',
            desc: race.raceTitle || '',
            url: race.raceUrl || '',
            distance: race.displayDistance || '',
            raceClass: race.raceClass || '',
            numberOfRunners: race.numberOfRunners || 0,
            meetingId: race.meetingId
          });
        }
      }
    }

    debug.push({
      step: 'filtered_gb_flat',
      totalMeetings: meetings.length,
      totalRaces: meetings.reduce((s, m) => s + (m.races?.length || 0), 0),
      gbFlatRaces: gbFlatRaces.length,
      courses: [...new Set(gbFlatRaces.map(r => r.course))],
      allCountries: [...new Set(meetings.flatMap(m => (m.races || []).map(r => r.country)))],
      elapsed: Date.now() - startTime
    });

    if (!gbFlatRaces.length) {
      return res.status(200).json({
        races: [], method: 'none',
        error: 'No GB flat races found today. Countries: ' +
          [...new Set(meetings.flatMap(m => (m.races || []).map(r => r.country)))].join(', '),
        debug
      });
    }

    // ── Step 4: Fetch individual race pages for runner data ──
    const races = [];
    const BATCH_SIZE = 6;
    const MAX_RACES = 30;
    const toFetch = gbFlatRaces.slice(0, MAX_RACES);

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      if (Date.now() - startTime > 8000) {
        debug.push({ step: 'timeout_bail', fetched: i, total: toFetch.length });
        break;
      }

      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (race) => {
          try {
            const resp = await fetch('https://www.racingpost.com' + race.url, {
              headers: FETCH_HEADERS,
              redirect: 'follow',
              signal: AbortSignal.timeout(4000)
            });
            if (!resp.ok) return null;
            const raceHtml = await resp.text();
            return { race, html: raceHtml };
          } catch (e) {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { race, html: raceHtml } = result.value;

        // Parse race page __NEXT_DATA__
        const raceNextData = extractNextData(raceHtml);
        let horses = [];

        if (raceNextData) {
          // Search for runner arrays in the race page data
          const found = findAllRunnerArrays(raceNextData);

          // Use the largest runner array
          let bestRunners = null;
          for (const { runners, raceInfo } of found) {
            if (!bestRunners || runners.length > bestRunners.length) {
              bestRunners = runners;
            }
          }

          if (bestRunners) {
            horses = bestRunners.map(r => extractRunner(r)).filter(h => h.name);
          }
        }

        // If __NEXT_DATA__ didn't yield runners, try fallback extraction
        if (!horses.length) {
          // Try RSC payloads
          const pushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
          let pm;
          let rscText = '';
          while ((pm = pushRe.exec(raceHtml)) !== null) {
            let unescaped;
            try { unescaped = JSON.parse('"' + pm[2] + '"'); }
            catch (e) { unescaped = pm[2].replace(/\\n/g, '\n').replace(/\\\//g, '/'); }
            rscText += unescaped + '\n';
          }

          if (rscText.length > 100) {
            // Parse RSC lines for JSON objects
            const rscObjects = [];
            for (const line of rscText.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const colonIdx = trimmed.indexOf(':');
              if (colonIdx < 0 || colonIdx > 6) continue;
              const prefix = trimmed.substring(0, colonIdx);
              if (!/^[\da-fA-F]+$/.test(prefix)) continue;
              const data = trimmed.substring(colonIdx + 1);
              if (data.length > 2 && (data[0] === '{' || data[0] === '[')) {
                try { rscObjects.push(JSON.parse(data)); } catch (e) {}
              }
            }

            for (const obj of rscObjects) {
              const found = findAllRunnerArrays(obj);
              for (const { runners } of found) {
                const extracted = runners.map(r => extractRunner(r)).filter(h => h.name);
                if (extracted.length > horses.length) horses = extracted;
              }
            }
          }
        }

        races.push({
          course: race.course,
          time: race.time,
          desc: race.desc,
          distance: race.distance,
          raceClass: race.raceClass,
          horses
        });

        // Debug: if no horses found, log for diagnostics
        if (!horses.length) {
          debug.push({
            step: 'no_runners_found',
            race: race.course + ' ' + race.time,
            url: race.url,
            hasNextData: raceHtml ? /__NEXT_DATA__/.test(raceHtml) : false,
            hasRSC: raceHtml ? /self\.__next_f/.test(raceHtml) : false
          });
        }
      }
    }

    debug.push({
      step: 'fetch_complete',
      totalRaces: races.length,
      racesWithRunners: races.filter(r => r.horses.length > 0).length,
      elapsed: Date.now() - startTime
    });

    // Sort by time
    races.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json({
      races,
      method: 'structured',
      debug
    });

  } catch (err) {
    debug.push({ step: 'error', message: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message, debug });
  }
}
