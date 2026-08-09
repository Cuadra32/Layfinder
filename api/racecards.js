/**
 * Smart racecards extraction endpoint.
 * Fetches Racing Post racecards and returns structured JSON.
 *
 * Racing Post data structure (verified via debug):
 *
 * INDEX PAGE: __NEXT_DATA__.props.pageProps.initialState.raceCards.meetings[].races[]
 *   race.country        = "GB" | "IRE" | "USA" | "FR"
 *   race.raceTypeCode   = "F" (flat) | "H" (hurdle) | "C" (chase)
 *   race.courseStyleName = "Chepstow" | "Leicester"
 *   race.raceStart      = "14:30"
 *   race.raceTitle      = full description
 *   race.raceUrl        = "/racecards/30/leicester/2026-08-09/924204"
 *
 * RACE PAGE: __NEXT_DATA__.props.pageProps.initialState.racePage.data
 *   .runners[] — array of runner objects:
 *     horseName, trainerName, trainerRtf (strike rate),
 *     forecastOddsValue (fractional, decimal = 1 + value),
 *     formFiguresData (array), nonRunner, startNumber, draw
 *   .raceDetails.bettingForecast[] — odds per startNumber:
 *     {oddsDesc: "2/9", oddsValue: 0.222, horses: [1]}
 */

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity'
};

/* ── Parse __NEXT_DATA__ from HTML ──────────────── */

function extractNextData(html) {
  const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

/* ── Extract runner from Racing Post runner object ── */

function extractRunner(r, bfMap) {
  // Skip non-runners
  if (r.nonRunner) return null;

  // Horse name
  const name = r.horseName || r.horseStyleName || '';
  if (!name) return null;

  // Odds — Racing Post uses forecastOddsValue (fractional part: 2/9 = 0.222)
  // Decimal odds = 1 + forecastOddsValue
  let oddsStr = '', oddsDec = null;

  if (typeof r.forecastOddsValue === 'number' && r.forecastOddsValue > 0) {
    oddsDec = 1 + r.forecastOddsValue;
    oddsStr = decToFrac(oddsDec);
  }

  // Fallback: use bettingForecast map (startNumber → {oddsDesc, oddsValue})
  if (!oddsDec && bfMap && r.startNumber) {
    const bf = bfMap[r.startNumber];
    if (bf) {
      oddsStr = bf.oddsDesc || '';
      oddsDec = 1 + (bf.oddsValue || 0);
    }
  }

  // Use the fractional odds string from bettingForecast if available (more readable)
  if (bfMap && r.startNumber && bfMap[r.startNumber]) {
    const bfOdds = bfMap[r.startNumber].oddsDesc;
    if (bfOdds) oddsStr = bfOdds;
  }

  // Form figures — Racing Post uses formFiguresData (array of form figure objects)
  let form = '';
  if (Array.isArray(r.formFiguresData)) {
    form = r.formFiguresData.map(function(f) {
      if (typeof f === 'string') return f;
      if (typeof f === 'number') return f >= 10 ? '0' : String(f);
      if (f && typeof f === 'object') {
        // Could be {character: "2"} or {position: 2} or {char: "2"} etc.
        const ch = f.character || f.char || f.figure || f.formChar;
        if (ch) return ch;
        const pos = f.position || f.pos || f.finishPosition;
        if (pos !== undefined) return pos >= 10 ? '0' : String(pos);
        return '';
      }
      return '';
    }).join('');
  } else if (typeof r.formFiguresData === 'string') {
    // Might be a JSON string
    try {
      const parsed = JSON.parse(r.formFiguresData);
      if (Array.isArray(parsed)) {
        form = parsed.map(function(f) {
          if (typeof f === 'string') return f;
          if (typeof f === 'number') return f >= 10 ? '0' : String(f);
          if (f && typeof f === 'object') {
            return f.character || f.char || f.figure || '';
          }
          return '';
        }).join('');
      } else {
        form = r.formFiguresData;
      }
    } catch (e) {
      form = r.formFiguresData;
    }
  }
  // Fallback: check other form field names
  if (!form) {
    const fallbackFormKeys = ['formFigures', 'form', 'recentForm'];
    for (const k of fallbackFormKeys) {
      const v = r[k];
      if (typeof v === 'string' && v.length >= 1 && /[0-9FPURSCBO-]/i.test(v)) {
        if (!/^\d{1,3}\/\d{1,3}$/.test(v)) { form = v; break; }
      }
    }
  }

  // Trainer — Racing Post uses trainerName
  const trainer = r.trainerName || r.trainerStyleName || '';

  // Trainer strike rate — Racing Post uses trainerRtf
  let trainerPct = null;
  if (typeof r.trainerRtf === 'number') {
    trainerPct = r.trainerRtf;
  } else if (typeof r.trainerRtf === 'string') {
    trainerPct = parseFloat(r.trainerRtf);
  }

  return {
    name,
    form,
    odds: oddsStr,
    oddsDecimal: oddsDec,
    trainer,
    trainerPct: trainerPct !== null && !isNaN(trainerPct) ? trainerPct : null
  };
}

/* ── Odds conversion helpers ────────────────────── */

function decToFrac(d) {
  if (!d || d <= 1) return 'EVS';
  const n = d - 1;
  // Common fractional odds lookup
  const tbl = [
    [1,6],[1,5],[1,4],[2,7],[1,3],[4,11],[2,5],[4,9],[1,2],[8,15],
    [4,7],[8,13],[4,6],[8,11],[4,5],[5,6],[10,11],
    [1,1],[6,5],[5,4],[11,8],[6,4],[13,8],[7,4],[15,8],
    [2,1],[9,4],[5,2],[11,4],[3,1],[10,3],[7,2],[4,1],
    [9,2],[5,1],[11,2],[6,1],[13,2],[7,1],[15,2],[8,1],
    [17,2],[9,1],[10,1],[11,1],[12,1],[14,1],[16,1],[20,1],
    [25,1],[28,1],[33,1],[40,1],[50,1],[66,1],[80,1],[100,1]
  ];
  let best = null, bd = 99;
  for (const f of tbl) {
    const diff = Math.abs(f[0] / f[1] - n);
    if (diff < bd) { bd = diff; best = f; }
  }
  // Only use the lookup if it's a close match
  if (best && bd < 0.05) return best[0] + '/' + best[1];
  // Otherwise compute nearest common fraction
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
      headers: FETCH_HEADERS, redirect: 'follow'
    });

    if (!indexResp.ok) {
      return res.status(502).json({ error: 'Racing Post HTTP ' + indexResp.status, debug });
    }

    const html = await indexResp.text();
    debug.push({ step: 'fetched_index', htmlLength: html.length, elapsed: Date.now() - startTime });

    // ── Step 2: Parse __NEXT_DATA__ ──
    const nextData = extractNextData(html);
    if (!nextData) {
      return res.status(200).json({ races: [], method: 'none', error: 'No __NEXT_DATA__', debug });
    }

    const initialState = nextData.props?.pageProps?.initialState || {};
    const meetings = initialState.raceCards?.meetings || [];

    // ── Step 3: Filter to GB flat races ──
    const gbFlatRaces = [];
    for (const meeting of meetings) {
      for (const race of (meeting.races || [])) {
        if (race.country === 'GB' && race.raceTypeCode === 'F') {
          gbFlatRaces.push({
            raceId: race.raceId,
            course: race.courseStyleName || race.name || '',
            time: race.raceStart || '',
            desc: race.raceTitle || '',
            url: race.raceUrl || '',
            distance: race.displayDistance || '',
            raceClass: race.raceClass || '',
            numberOfRunners: race.numberOfRunners || 0
          });
        }
      }
    }

    debug.push({
      step: 'filtered_gb_flat',
      totalMeetings: meetings.length,
      gbFlatRaces: gbFlatRaces.length,
      courses: [...new Set(gbFlatRaces.map(r => r.course))],
      elapsed: Date.now() - startTime
    });

    if (!gbFlatRaces.length) {
      return res.status(200).json({
        races: [], method: 'none',
        error: 'No GB flat races found today',
        debug
      });
    }

    // ── Step 4: Fetch individual race pages for runner data ──
    const races = [];
    const BATCH_SIZE = 6;
    const toFetch = gbFlatRaces.slice(0, 30);

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
            return { race, html: await resp.text() };
          } catch (e) {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { race, html: raceHtml } = result.value;

        const raceNextData = extractNextData(raceHtml);
        let horses = [];

        if (raceNextData) {
          // Direct access to runner data at the known path
          const racePageData = raceNextData.props?.pageProps?.initialState?.racePage?.data;

          if (racePageData && Array.isArray(racePageData.runners)) {
            // Build betting forecast map: startNumber → {oddsDesc, oddsValue}
            const bfMap = {};
            const bettingForecast = racePageData.raceDetails?.bettingForecast || [];
            for (const bf of bettingForecast) {
              const bfHorses = bf.horses || [];
              for (const startNum of bfHorses) {
                bfMap[startNum] = { oddsDesc: bf.oddsDesc, oddsValue: bf.oddsValue };
              }
            }

            horses = racePageData.runners
              .map(r => extractRunner(r, bfMap))
              .filter(h => h !== null && h.name);

            // Update course/time from race page data if available
            if (racePageData.race) {
              if (racePageData.race.diffusionCourseName) {
                race.course = racePageData.race.diffusionCourseName;
              }
              if (racePageData.race.raceTime) {
                const tm = racePageData.race.raceTime.match(/(\d{1,2})[:.]\s?(\d{2})/);
                if (tm) race.time = tm[1] + ':' + tm[2];
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

        if (!horses.length) {
          debug.push({
            step: 'no_runners',
            race: race.course + ' ' + race.time,
            url: race.url,
            hasNextData: !!raceNextData,
            hasRacePageData: !!(raceNextData?.props?.pageProps?.initialState?.racePage?.data)
          });
        }
      }
    }

    // Sort by time
    races.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    debug.push({
      step: 'complete',
      totalRaces: races.length,
      racesWithRunners: races.filter(r => r.horses.length > 0).length,
      totalHorses: races.reduce((s, r) => s + r.horses.length, 0),
      elapsed: Date.now() - startTime
    });

    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json({ races, method: 'structured', debug });

  } catch (err) {
    debug.push({ step: 'error', message: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message, debug });
  }
}
