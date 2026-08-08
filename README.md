# LayFinder

UK flat racing lay betting analysis tool. Identifies horses least likely to win based on:

- **Trainer strike rate** (0–40 pts) — worst performing trainers score highest
- **Recent form** (0–40 pts) — poor finishing positions, falls, and pull-ups score highest
- **Odds adjustment** (0–20 pts) — shorter odds with bad fundamentals = bigger market error

Only considers UK flat races (no jumps) at odds of 8/1 and below.

## How it works

1. Click **Load Today's UK Flat Races** to auto-fetch racecards from Racing Post
2. Or enter a specific Racing Post racecard URL
3. Or paste racecard text directly
4. Edit form figures and trainer strike rates inline — scores update live
5. Top lay candidates are ranked in a summary table

## Deploy

Deploy to [Vercel](https://vercel.com) — the serverless function in `api/` proxies Racing Post requests server-side to bypass CORS.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Cuadra32/layfinder)

## Stack

- Single HTML page, zero dependencies
- Vercel serverless function for Racing Post proxy
- Multi-strategy parser: embedded JSON → state variables → text fallback
