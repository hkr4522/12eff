# MX Resolver API for Vercel

This project ports the supplied PHP MX Player TV-show/episode resolver to a Node.js Vercel Function.

## Deploy

1. Upload this folder to a Git repository and import it into Vercel.
2. In Vercel → Project → Settings → Environment Variables, add `TMDB_API_KEY` with your TMDB API key.
3. Deploy.

No third-party npm dependencies are required; it uses Node.js native `fetch`.

## Endpoints

- `/api/mx?id=306118&s=1&e=1`
- `/api/mx?id=112888&s=1`
- `/api/mx?query=Arafta&s=1&e=1`
- `/api/mx?id=306118&s=1&e=1&debug=1`
- `/api/mx?id=<32-character-season-id>&e=1`

`debug=1` includes request diagnostics. If the upstream responds with a Cloudflare challenge page, the API reports `UPSTREAM_CHALLENGE`; it does not attempt to defeat CAPTCHA or anti-bot controls.

## Notes

- This uses direct HTTPS requests; the PHP public-proxy pool is not included.
- Cache is in-memory per warm serverless instance only. It is not shared across Vercel instances and may disappear between invocations.
- Vercel Functions are time-limited. Large season pagination may take longer than the configured function limit.
- Use only data and endpoints you are authorized to access. Keep `TMDB_API_KEY` in environment variables, never in source code.
