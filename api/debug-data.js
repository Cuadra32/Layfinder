/**
 * Debug v3: Focus on the RACE PAGE data structure.
 * We know the index page works — now we need to see
 * what a race page's __NEXT_DATA__ contains for runners.
 */

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const result = {};

  try {
    // Step 1: Get index to find a GB flat race URL
    const indexResp = await fetch('https://www.racingpost.com/racecards/', {
      headers: FETCH_HEADERS, redirect: 'follow'
    });
    const html = await indexResp.text();
    const ndm = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!ndm) return res.status(200).json({ error: 'No __NEXT_DATA__ on index' });

    const nextData = JSON.parse(ndm[1]);
    const meetings = nextData.props?.pageProps?.initialState?.raceCards?.meetings || [];

    // Find first GB flat race
    let targetRace = null;
    for (const m of meetings) {
      for (const r of (m.races || [])) {
        if (r.country === 'GB' && r.raceTypeCode === 'F') {
          targetRace = r;
          break;
        }
      }
      if (targetRace) break;
    }

    if (!targetRace) return res.status(200).json({ error: 'No GB flat races found' });

    result.targetRace = {
      course: targetRace.courseStyleName,
      time: targetRace.raceStart,
      title: targetRace.raceTitle,
      url: targetRace.raceUrl,
      runners: targetRace.numberOfRunners
    };

    // Step 2: Fetch the race page
    const raceResp = await fetch('https://www.racingpost.com' + targetRace.raceUrl, {
      headers: FETCH_HEADERS, redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    if (!raceResp.ok) {
      return res.status(200).json({ ...result, error: 'Race page HTTP ' + raceResp.status });
    }

    const raceHtml = await raceResp.text();
    result.racePageInfo = {
      htmlLength: raceHtml.length,
      hasNextData: /__NEXT_DATA__/.test(raceHtml),
      hasRSC: /self\.__next_f/.test(raceHtml),
      scriptCount: (raceHtml.match(/<script/gi) || []).length
    };

    // Step 3: Parse __NEXT_DATA__ from race page
    const rndm = raceHtml.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (rndm) {
      const raceNextData = JSON.parse(rndm[1]);
      const racePageProps = raceNextData.props?.pageProps || {};
      const raceInitialState = racePageProps.initialState || {};

      result.racePageKeys = {
        pagePropsKeys: Object.keys(racePageProps),
        initialStateKeys: Object.keys(raceInitialState)
      };

      // Show structure of key sections
      const racePageData = raceInitialState.racePage?.data;
      if (racePageData) {
        result.racePageData = {
          type: typeof racePageData,
          keys: typeof racePageData === 'object' ? Object.keys(racePageData) : null
        };

        // Look for runners inside racePage.data
        if (typeof racePageData === 'object') {
          for (const [k, v] of Object.entries(racePageData)) {
            if (Array.isArray(v) && v.length > 0) {
              const sample = v[0];
              result.racePageData['array_' + k] = {
                length: v.length,
                firstItemKeys: sample && typeof sample === 'object' ? Object.keys(sample) : typeof sample,
                firstItem: summarize(sample)
              };
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
              result.racePageData['obj_' + k] = {
                keys: Object.keys(v).slice(0, 15)
              };
              // Check for arrays inside this object
              for (const [k2, v2] of Object.entries(v)) {
                if (Array.isArray(v2) && v2.length > 0 && v2[0] && typeof v2[0] === 'object') {
                  result.racePageData['obj_' + k + '.' + k2] = {
                    length: v2.length,
                    firstItemKeys: Object.keys(v2[0]),
                    firstItem: summarize(v2[0])
                  };
                }
              }
            }
          }
        }
      } else {
        result.racePageData = 'null or undefined';
        // Look for race data elsewhere
        result.racePageState = {};
        for (const [k, v] of Object.entries(raceInitialState)) {
          if (v && typeof v === 'object') {
            const keys = Object.keys(v);
            result.racePageState[k] = keys.length > 10 ? keys.slice(0, 10).concat(['...(' + keys.length + ')']) : keys;
          }
        }
      }

      // Also check pageProps directly for race data
      result.pagePropsStrings = {};
      for (const [k, v] of Object.entries(racePageProps)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 200) {
          result.pagePropsStrings[k] = v;
        }
      }

      // Deep search: find ALL arrays with 3+ objects anywhere in the data
      const allArrays = [];
      function deepSearch(obj, path, depth) {
        if (!obj || typeof obj !== 'object' || depth > 8) return;
        if (Array.isArray(obj)) {
          if (obj.length >= 3 && obj[0] && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
            const keys = Object.keys(obj[0]);
            allArrays.push({
              path,
              length: obj.length,
              keys,
              firstItem: summarize(obj[0])
            });
          }
          for (let i = 0; i < Math.min(obj.length, 2); i++) {
            if (obj[i] && typeof obj[i] === 'object') {
              deepSearch(obj[i], path + '[' + i + ']', depth + 1);
            }
          }
        } else {
          for (const k of Object.keys(obj)) {
            if (obj[k] && typeof obj[k] === 'object') {
              deepSearch(obj[k], path + '.' + k, depth + 1);
            }
          }
        }
      }
      deepSearch(raceNextData, 'root', 0);
      // Sort by most keys (runner arrays tend to have many fields)
      allArrays.sort((a, b) => b.keys.length - a.keys.length);
      result.allArraysInRacePage = allArrays.slice(0, 10);

    } else if (/self\.__next_f/.test(raceHtml)) {
      // RSC fallback
      result.racePageFormat = 'RSC (no __NEXT_DATA__)';
      const pushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
      let pm;
      let rscText = '';
      let chunkCount = 0;
      while ((pm = pushRe.exec(raceHtml)) !== null) {
        let unescaped;
        try { unescaped = JSON.parse('"' + pm[2] + '"'); }
        catch (e) { unescaped = pm[2].replace(/\\n/g, '\n').replace(/\\\//g, '/'); }
        rscText += unescaped + '\n';
        chunkCount++;
      }
      result.rsc = { chunkCount, textLength: rscText.length, sample: rscText.substring(0, 3000) };
    } else {
      result.racePageFormat = 'Unknown (no __NEXT_DATA__, no RSC)';
      // Show some HTML patterns
      result.htmlSample = raceHtml.substring(0, 2000);
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ error: err.message, stack: err.stack });
  }
}

function summarize(item) {
  if (!item || typeof item !== 'object') return item;
  const s = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === null || v === undefined) s[k] = null;
    else if (typeof v === 'string') s[k] = v.length > 100 ? v.substring(0, 100) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') s[k] = v;
    else if (Array.isArray(v)) s[k] = '[' + v.length + ']';
    else if (typeof v === 'object') s[k] = '{' + Object.keys(v).slice(0, 6).join(',') + '}';
  }
  return s;
}
