/**
 * Debug endpoint: dumps raw Racing Post data structure.
 * Visit /api/debug-data to see what Racing Post actually returns.
 * This lets us see the real field names for horses, form, odds, etc.
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

  const result = {
    timestamp: new Date().toISOString(),
    steps: []
  };

  try {
    // Step 1: Fetch racecards index
    const indexResp = await fetch('https://www.racingpost.com/racecards/', {
      headers: FETCH_HEADERS, redirect: 'follow'
    });

    if (!indexResp.ok) {
      result.error = 'Racing Post returned HTTP ' + indexResp.status;
      return res.status(200).json(result);
    }

    const html = await indexResp.text();
    result.steps.push({
      step: 'index_fetched',
      htmlLength: html.length,
      hasNextData: /__NEXT_DATA__/.test(html),
      hasRSC: /self\.__next_f/.test(html),
      scriptCount: (html.match(/<script/gi) || []).length
    });

    // Step 2: Extract __NEXT_DATA__
    const nextDataRe = /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
    const ndm = html.match(nextDataRe);
    if (ndm) {
      try {
        const nd = JSON.parse(ndm[1]);
        result.nextData = {
          topKeys: Object.keys(nd),
          propsKeys: nd.props ? Object.keys(nd.props) : null,
          pagePropsKeys: nd.props && nd.props.pageProps ? Object.keys(nd.props.pageProps) : null,
          // Sample the structure
          pagePropsSnippet: nd.props && nd.props.pageProps
            ? JSON.stringify(nd.props.pageProps).substring(0, 5000)
            : null
        };
      } catch (e) {
        result.nextData = { error: e.message };
      }
    }

    // Step 3: Extract RSC payloads
    const pushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
    let pm;
    let rscChunks = [];
    let rscText = '';
    while ((pm = pushRe.exec(html)) !== null) {
      let unescaped;
      try {
        unescaped = JSON.parse('"' + pm[2] + '"');
      } catch (e) {
        unescaped = pm[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
      }
      rscChunks.push(unescaped);
      rscText += unescaped + '\n';
    }

    result.rsc = {
      chunkCount: rscChunks.length,
      totalTextLength: rscText.length,
      // Show first 3 chunks as sample
      sampleChunks: rscChunks.slice(0, 3).map(c => c.substring(0, 500))
    };

    // Step 4: Parse RSC lines and find JSON objects
    const jsonObjects = [];
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
          jsonObjects.push({ prefix, type: Array.isArray(parsed) ? 'array' : 'object', data: parsed });
        } catch (e) {
          // Try array parsing
          if (data[0] === '[') {
            try {
              const arr = JSON.parse(data);
              jsonObjects.push({ prefix, type: 'array', data: arr });
            } catch (e2) {}
          }
        }
      }
    }

    result.steps.push({
      step: 'rsc_parsed',
      jsonObjectCount: jsonObjects.length
    });

    // Step 5: Find arrays that look like runner/horse data
    const runnerLikeArrays = [];
    function searchForArrays(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 10) return;
      if (Array.isArray(obj)) {
        if (obj.length >= 2 && obj[0] && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
          const keys = Object.keys(obj[0]);
          // Check if it looks like runner data
          const keyStr = keys.join(',').toLowerCase();
          const signals = ['horse','name','runner','jockey','trainer','form','odds','silk',
            'draw','cloth','number','saddlecloth','saddle','uid','id','price','weight',
            'age','sex','rating','rpr','topspeed','ts','bred','sire','dam','owner',
            'colour','headgear','blinkers','visor','cheekpieces','tongue'];
          let hits = 0;
          for (const s of signals) {
            if (keyStr.includes(s)) hits++;
          }
          if (hits >= 2 || (keys.length >= 4 && keys.length <= 50)) {
            runnerLikeArrays.push({
              path,
              arrayLength: obj.length,
              firstItemKeys: keys,
              signalHits: hits,
              // Show first 2 items raw
              sampleItems: obj.slice(0, 2)
            });
          }
        }
        // Search items
        for (let i = 0; i < Math.min(obj.length, 5); i++) {
          searchForArrays(obj[i], path + '[' + i + ']', depth + 1);
        }
      } else {
        for (const k of Object.keys(obj)) {
          searchForArrays(obj[k], path + '.' + k, depth + 1);
        }
      }
    }

    for (let i = 0; i < jsonObjects.length; i++) {
      searchForArrays(jsonObjects[i].data, 'rsc[' + jsonObjects[i].prefix + ']', 0);
    }

    // Sort by signal hits
    runnerLikeArrays.sort((a, b) => b.signalHits - a.signalHits);

    result.runnerArrays = {
      found: runnerLikeArrays.length,
      // Show top 5 most likely runner arrays
      top: runnerLikeArrays.slice(0, 5)
    };

    // Step 6: Find race URLs
    const clean = html.replace(/\\+\//g, '/');
    const urlRe = /\/racecards\/(\d+)\/([a-z][a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)/gi;
    const urls = [];
    const seenUrls = new Set();
    let um;
    while ((um = urlRe.exec(clean)) !== null) {
      const href = um[0];
      if (!seenUrls.has(href)) {
        seenUrls.add(href);
        urls.push({
          href,
          courseId: um[1],
          slug: um[2],
          date: um[3],
          raceId: um[4]
        });
      }
    }

    // Group by slug
    const slugCounts = {};
    for (const u of urls) {
      slugCounts[u.slug] = (slugCounts[u.slug] || 0) + 1;
    }

    result.urls = {
      total: urls.length,
      slugCounts,
      // Show first 10 URLs
      sample: urls.slice(0, 10)
    };

    // Step 7: Fetch ONE race page and dump its data structure
    if (urls.length > 0) {
      // Pick a UK-looking URL if possible
      const ukSlugs = new Set(['ascot','ayr','bath','beverley','brighton','carlisle',
        'catterick','catterick-bridge','chelmsford','chelmsford-city','chepstow','chester',
        'doncaster','epsom','epsom-downs','ffos-las','goodwood','great-yarmouth','yarmouth',
        'hamilton','hamilton-park','haydock','haydock-park','kempton','kempton-park',
        'leicester','lingfield','lingfield-park','musselburgh','newbury','newcastle',
        'newmarket','nottingham','pontefract','redcar','ripon','salisbury','sandown',
        'sandown-park','southwell','thirsk','wetherby','windsor','wolverhampton','york']);

      const target = urls.find(u => ukSlugs.has(u.slug)) || urls[0];

      try {
        const raceResp = await fetch('https://www.racingpost.com' + target.href, {
          headers: FETCH_HEADERS,
          redirect: 'follow',
          signal: AbortSignal.timeout(6000)
        });

        if (raceResp.ok) {
          const raceHtml = await raceResp.text();

          // Extract JSON from race page
          const raceJsonObjects = [];

          // __NEXT_DATA__
          const rndm = raceHtml.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
          if (rndm) {
            try {
              raceJsonObjects.push({ source: '__NEXT_DATA__', data: JSON.parse(rndm[1]) });
            } catch (e) {}
          }

          // RSC payloads from race page
          const racePushRe = /self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g;
          let rpm;
          let raceRscText = '';
          while ((rpm = racePushRe.exec(raceHtml)) !== null) {
            let unescaped;
            try {
              unescaped = JSON.parse('"' + rpm[2] + '"');
            } catch (e) {
              unescaped = rpm[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
            }
            raceRscText += unescaped + '\n';
          }

          // Parse RSC lines
          const raceLines = raceRscText.split('\n');
          for (const rl of raceLines) {
            const trimmed = rl.trim();
            if (!trimmed) continue;
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx < 0 || colonIdx > 6) continue;
            const prefix = trimmed.substring(0, colonIdx);
            if (!/^[\da-fA-F]+$/.test(prefix)) continue;
            const data = trimmed.substring(colonIdx + 1);
            if (data.length > 2 && (data[0] === '{' || data[0] === '[')) {
              try {
                raceJsonObjects.push({ source: 'RSC:' + prefix, data: JSON.parse(data) });
              } catch (e) {}
            }
          }

          // Search for runner arrays in race page data
          const raceRunnerArrays = [];
          function searchRacePage(obj, path, depth) {
            if (!obj || typeof obj !== 'object' || depth > 10) return;
            if (Array.isArray(obj)) {
              if (obj.length >= 2 && obj[0] && typeof obj[0] === 'object' && !Array.isArray(obj[0])) {
                const keys = Object.keys(obj[0]);
                const keyStr = keys.join(',').toLowerCase();
                const signals = ['horse','name','runner','jockey','trainer','form','odds',
                  'silk','draw','cloth','number','saddlecloth','uid','id','price','weight'];
                let hits = 0;
                for (const s of signals) {
                  if (keyStr.includes(s)) hits++;
                }
                if (hits >= 2) {
                  raceRunnerArrays.push({
                    path,
                    arrayLength: obj.length,
                    firstItemKeys: keys,
                    signalHits: hits,
                    // Show first 2 items completely
                    sampleItems: obj.slice(0, 2)
                  });
                }
              }
              for (let i = 0; i < Math.min(obj.length, 3); i++) {
                searchRacePage(obj[i], path + '[' + i + ']', depth + 1);
              }
            } else {
              for (const k of Object.keys(obj)) {
                searchRacePage(obj[k], path + '.' + k, depth + 1);
              }
            }
          }

          for (const rjo of raceJsonObjects) {
            searchRacePage(rjo.data, rjo.source, 0);
          }

          raceRunnerArrays.sort((a, b) => b.signalHits - a.signalHits);

          result.racePage = {
            url: target.href,
            slug: target.slug,
            courseId: target.courseId,
            htmlLength: raceHtml.length,
            hasNextData: /__NEXT_DATA__/.test(raceHtml),
            hasRSC: /self\.__next_f/.test(raceHtml),
            jsonObjectCount: raceJsonObjects.length,
            runnerArraysFound: raceRunnerArrays.length,
            // Show top 3 runner arrays with FULL first item data
            topRunnerArrays: raceRunnerArrays.slice(0, 3).map(ra => ({
              ...ra,
              // Truncate sample items to avoid huge response
              sampleItems: ra.sampleItems.map(item => {
                const str = JSON.stringify(item);
                if (str.length > 3000) {
                  // Show keys and first values
                  const summary = {};
                  for (const [k, v] of Object.entries(item)) {
                    if (typeof v === 'string') summary[k] = v.substring(0, 200);
                    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) summary[k] = v;
                    else if (Array.isArray(v)) summary[k] = '[Array(' + v.length + ')]';
                    else if (typeof v === 'object' && v) summary[k] = '{' + Object.keys(v).join(',') + '}';
                    else summary[k] = typeof v;
                  }
                  return summary;
                }
                return item;
              })
            }))
          };

          // Also dump some raw HTML patterns for debugging
          // Look for data-testid or class patterns that might help
          const testIds = raceHtml.match(/data-testid="[^"]+"/g) || [];
          const uniqueTestIds = [...new Set(testIds)].slice(0, 30);
          result.racePage.testIds = uniqueTestIds;

        } else {
          result.racePage = { error: 'HTTP ' + raceResp.status, url: target.href };
        }
      } catch (e) {
        result.racePage = { error: e.message };
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    result.error = err.message;
    return res.status(200).json(result);
  }
}
