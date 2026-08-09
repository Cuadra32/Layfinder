/**
 * Debug v4: Dump FULL first runner object + trainer fields.
 * We need to see all available fields to find the real trainer win rate.
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

    // Step 3: Parse __NEXT_DATA__ from race page
    const rndm = raceHtml.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!rndm) {
      return res.status(200).json({ ...result, error: 'No __NEXT_DATA__ on race page' });
    }

    const raceNextData = JSON.parse(rndm[1]);
    const racePageData = raceNextData.props?.pageProps?.initialState?.racePage?.data;

    if (!racePageData) {
      return res.status(200).json({ ...result, error: 'No racePage.data' });
    }

    // Get runners
    const runners = racePageData.runners || [];
    result.runnerCount = runners.length;

    if (runners.length > 0) {
      // FULL first runner — no summarization, all fields visible
      const firstRunner = runners[0];
      result.firstRunnerFull = {};
      for (const [k, v] of Object.entries(firstRunner)) {
        if (v === null || v === undefined) {
          result.firstRunnerFull[k] = null;
        } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          result.firstRunnerFull[k] = v;
        } else if (Array.isArray(v)) {
          // Show full array content for small arrays, summarize large ones
          result.firstRunnerFull[k] = v.length <= 20 ? v : { length: v.length, first3: v.slice(0, 3) };
        } else if (typeof v === 'object') {
          // Show full nested object
          result.firstRunnerFull[k] = v;
        }
      }

      // Show ALL keys that contain "trainer" (case-insensitive)
      result.trainerFields = {};
      for (const [k, v] of Object.entries(firstRunner)) {
        if (k.toLowerCase().includes('trainer') || k.toLowerCase().includes('strike') ||
            k.toLowerCase().includes('rate') || k.toLowerCase().includes('rtf') ||
            k.toLowerCase().includes('percent') || k.toLowerCase().includes('win')) {
          result.trainerFields[k] = v;
        }
      }

      // Second runner for comparison
      if (runners.length > 1) {
        const secondRunner = runners[1];
        result.secondRunnerTrainerFields = {};
        for (const [k, v] of Object.entries(secondRunner)) {
          if (k.toLowerCase().includes('trainer') || k.toLowerCase().includes('strike') ||
              k.toLowerCase().includes('rate') || k.toLowerCase().includes('rtf') ||
              k.toLowerCase().includes('percent') || k.toLowerCase().includes('win') ||
              k === 'horseName' || k === 'forecastOddsValue') {
            result.secondRunnerTrainerFields[k] = v;
          }
        }
      }
    }

    // Betting forecast
    const bf = racePageData.raceDetails?.bettingForecast || [];
    result.bettingForecast = bf.slice(0, 5);

    // Race details keys
    if (racePageData.raceDetails) {
      result.raceDetailsKeys = Object.keys(racePageData.raceDetails);
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ error: err.message, stack: err.stack });
  }
}
