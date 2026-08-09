/**
 * Debug endpoint v2: drills into __NEXT_DATA__.props.pageProps.initialState
 * to find actual race/runner data structure from Racing Post.
 */

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity'
};

/**
 * Recursively find arrays that look like runner/horse data.
 * Returns path + sample items so we can see real field names.
 */
function findInterestingArrays(obj, path, depth, results) {
  if (!obj || typeof obj !== 'object' || depth > 12) return;
  results = results || [];

  if (Array.isArray(obj)) {
    if (obj.length >= 2 && obj[0] && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
      const keys = Object.keys(obj[0]);
      const keyStr = keys.join(',').toLowerCase();
      // Check for runner-like, race-like, or meeting-like arrays
      const runnerSignals = ['horse','name','runner','jockey','trainer','form','odds','silk',
        'draw','cloth','number','uid','id','price','age','weight','rating'];
      const raceSignals = ['race','time','off','runners','distance','class','going','prize'];
      const meetingSignals = ['meeting','course','venue','races','country','region'];

      let runnerHits = 0, raceHits = 0, meetingHits = 0;
      for (const s of runnerSignals) { if (keyStr.includes(s)) runnerHits++; }
      for (const s of raceSignals) { if (keyStr.includes(s)) raceHits++; }
      for (const s of meetingSignals) { if (keyStr.includes(s)) meetingHits++; }

      if (runnerHits >= 2 || raceHits >= 2 || meetingHits >= 2 || keys.length >= 5) {
        // Summarize each item: show keys + values (truncated)
        const summarize = (item) => {
          const summary = {};
          for (const [k, v] of Object.entries(item)) {
            if (v === null || v === undefined) summary[k] = null;
            else if (typeof v === 'string') summary[k] = v.length > 150 ? v.substring(0, 150) + '...' : v;
            else if (typeof v === 'number' || typeof v === 'boolean') summary[k] = v;
            else if (Array.isArray(v)) summary[k] = `[Array(${v.length})]`;
            else if (typeof v === 'object') summary[k] = `{${Object.keys(v).slice(0, 8).join(',')}}`;
          }
          return summary;
        };

        results.push({
          path,
          arrayLength: obj.length,
          signals: { runner: runnerHits, race: raceHits, meeting: meetingHits },
          firstItemKeys: keys,
          sample: obj.slice(0, 2).map(summarize)
        });
      }
    }
    // Search inside array items
    for (let i = 0; i < Math.min(obj.length, 5); i++) {
      if (obj[i] && typeof obj[i] === 'object') {
        findInterestingArrays(obj[i], path + '[' + i + ']', depth + 1, results);
      }
    }
  } else {
    for (const k of Object.keys(obj)) {
      if (obj[k] && typeof obj[k] === 'object') {
        findInterestingArrays(obj[k], path + '.' + k, depth + 1, results);
      }
    }
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const result = { timestamp: new Date().toISOString() };

  try {
    // ── Part A: Inspect the racecards INDEX page ──
    const indexResp = await fetch('https://www.racingpost.com/racecards/', {
      headers: FETCH_HEADERS, redirect: 'follow'
    });
    if (!indexResp.ok) {
      return res.status(200).json({ error: 'HTTP ' + indexResp.status });
    }
    const html = await indexResp.text();

    // Parse __NEXT_DATA__
    const ndm = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!ndm) {
      return res.status(200).json({ error: 'No __NEXT_DATA__ found', htmlLength: html.length });
    }

    const nextData = JSON.parse(ndm[1]);
    const pageProps = nextData.props?.pageProps || {};
    const initialState = pageProps.initialState || {};

    result.indexPage = {
      nextDataTopKeys: Object.keys(nextData),
      pagePropsKeys: Object.keys(pageProps),
      initialStateKeys: Object.keys(initialState)
    };

    // Drill into initialState — show keys at each level
    for (const [k, v] of Object.entries(initialState)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        result.indexPage['initialState.' + k + '.keys'] = Object.keys(v).slice(0, 20);
      } else if (Array.isArray(v)) {
        result.indexPage['initialState.' + k] = `[Array(${v.length})]`;
        if (v.length > 0 && v[0] && typeof v[0] === 'object') {
          result.indexPage['initialState.' + k + '[0].keys'] = Object.keys(v[0]).slice(0, 30);
        }
      }
    }

    // Find all interesting arrays in the __NEXT_DATA__
    const indexArrays = findInterestingArrays(nextData, 'nextData', 0);
    // Sort by total signals
    indexArrays.sort((a, b) => (b.signals.runner + b.signals.race + b.signals.meeting) - (a.signals.runner + a.signals.race + a.signals.meeting));
    result.indexPage.interestingArrays = indexArrays.slice(0, 10);

    // Find race URLs in the HTML
    const clean = html.replace(/\\+\//g, '/');
    const urlRe = /\/racecards\/(\d+)\/([a-z][a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)/gi;
    const urls = [];
    const seenUrls = new Set();
    let um;
    while ((um = urlRe.exec(clean)) !== null) {
      if (!seenUrls.has(um[0])) {
        seenUrls.add(um[0]);
        urls.push({ href: um[0], courseId: um[1], slug: um[2], date: um[3], raceId: um[4] });
      }
    }

    const slugGroups = {};
    for (const u of urls) {
      if (!slugGroups[u.slug]) slugGroups[u.slug] = [];
      slugGroups[u.slug].push(u.courseId);
    }
    result.indexPage.raceUrls = {
      total: urls.length,
      slugGroups: Object.fromEntries(
        Object.entries(slugGroups).map(([slug, ids]) => [slug, { count: ids.length, courseIds: [...new Set(ids)] }])
      ),
      sampleUrls: urls.slice(0, 5)
    };

    // ── Part B: Fetch ONE individual race page and inspect it ──
    const ukSlugs = new Set(['ascot','ayr','bath','beverley','brighton','carlisle',
      'catterick','catterick-bridge','chelmsford','chelmsford-city','chepstow','chester',
      'doncaster','epsom','epsom-downs','ffos-las','goodwood','great-yarmouth','yarmouth',
      'hamilton','hamilton-park','haydock','haydock-park','kempton','kempton-park',
      'leicester','lingfield','lingfield-park','musselburgh','newbury','newcastle',
      'newmarket','nottingham','pontefract','redcar','ripon','salisbury','sandown',
      'sandown-park','southwell','thirsk','wetherby','windsor','wolverhampton','york']);

    const target = urls.find(u => ukSlugs.has(u.slug)) || urls[0];

    if (target) {
      try {
        const raceResp = await fetch('https://www.racingpost.com' + target.href, {
          headers: FETCH_HEADERS, redirect: 'follow',
          signal: AbortSignal.timeout(6000)
        });

        if (raceResp.ok) {
          const raceHtml = await raceResp.text();
          const rndm = raceHtml.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);

          if (rndm) {
            const raceNextData = JSON.parse(rndm[1]);
            const racePageProps = raceNextData.props?.pageProps || {};
            const raceInitialState = racePageProps.initialState || {};

            result.racePage = {
              url: target.href,
              slug: target.slug,
              courseId: target.courseId,
              pagePropsKeys: Object.keys(racePageProps),
              initialStateKeys: Object.keys(raceInitialState)
            };

            // Show structure of initialState
            for (const [k, v] of Object.entries(raceInitialState)) {
              if (v && typeof v === 'object' && !Array.isArray(v)) {
                result.racePage['state.' + k + '.keys'] = Object.keys(v).slice(0, 25);
              } else if (Array.isArray(v)) {
                result.racePage['state.' + k] = `[Array(${v.length})]`;
                if (v.length > 0 && v[0] && typeof v[0] === 'object') {
                  result.racePage['state.' + k + '[0].keys'] = Object.keys(v[0]).slice(0, 30);
                }
              }
            }

            // Find runner arrays in race page data
            const raceArrays = findInterestingArrays(raceNextData, 'raceData', 0);
            raceArrays.sort((a, b) => (b.signals.runner + b.signals.race + b.signals.meeting) - (a.signals.runner + a.signals.race + a.signals.meeting));
            result.racePage.interestingArrays = raceArrays.slice(0, 8);

            // Also try to find race-level info (course, time, etc.)
            // Look for any string fields at the pageProps level
            const raceMetadata = {};
            for (const [k, v] of Object.entries(racePageProps)) {
              if (typeof v === 'string' && v.length > 0 && v.length < 200) {
                raceMetadata[k] = v;
              } else if (typeof v === 'number') {
                raceMetadata[k] = v;
              }
            }
            if (Object.keys(raceMetadata).length) {
              result.racePage.metadata = raceMetadata;
            }

          } else {
            // Check for RSC on race page
            const hasRSC = /self\.__next_f/.test(raceHtml);
            result.racePage = {
              url: target.href,
              error: 'No __NEXT_DATA__ on race page',
              hasRSC,
              htmlLength: raceHtml.length
            };

            if (hasRSC) {
              // Extract RSC and look for data
              const pushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
              let pm;
              let rscText = '';
              while ((pm = pushRe.exec(raceHtml)) !== null) {
                let unescaped;
                try { unescaped = JSON.parse('"' + pm[2] + '"'); }
                catch (e) { unescaped = pm[2].replace(/\\n/g, '\n').replace(/\\\//g, '/'); }
                rscText += unescaped + '\n';
              }
              result.racePage.rscTextLength = rscText.length;
              result.racePage.rscSample = rscText.substring(0, 3000);
            }
          }
        } else {
          result.racePage = { url: target.href, error: 'HTTP ' + raceResp.status };
        }
      } catch (e) {
        result.racePage = { error: e.message };
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ error: err.message, stack: err.stack });
  }
}
