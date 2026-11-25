# Lumina Adventure P2R proxy

This Node.js service runs outside the RPG Maker game folder. It holds the P2R
client credentials, requests and caches the short-lived game access token, and
forwards only the P2R API routes needed by the game. It never writes player
bearer tokens or client secrets to logs.

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, copy `.env.example` to `.env`.
3. Fill in `P2R_CLIENT_ID` and `P2R_CLIENT_SECRET` using the newly rotated
   credentials from P2R. Do not copy credentials into the game project.
4. Keep `P2R_API_BASE_URL` as `https://pameran.devsaka.id/api/v1`.
5. Add the exact origin serving the game to `ALLOWED_ORIGINS`. The examples
   cover common local web-server addresses; replace or add the address actually
   shown by the web server.
6. Open a terminal in this folder and run:

   ```text
   npm install
   npm start
   ```

7. Check `http://localhost:3000/health`. A healthy response contains
   `"success": true`.

The actual `.env` file is ignored by Git. Never upload it, add it to the game
folder, or include it in a browser build.

## Deploy separately

Deploy this folder as its own Node.js web service on Render, Railway, or a VPS;
do not deploy it as part of the RPG Maker game's static files. Set the same
values as environment variables in the hosting dashboard instead of uploading
`.env`. Set `ALLOWED_ORIGINS` to the exact HTTPS origin hosting the game, and
use the generated HTTPS proxy URL as the game's server URL in a later plugin
stage.

For a Git-based host, first create a separate private Git repository containing
only this proxy folder. Do not put it in the game repository. Do not add `.env`
or `node_modules`. Connect that private repository to Render/Railway, select
Node.js 20 or newer, use `npm install` as the install command and `npm start`
as the start command, then add `P2R_CLIENT_ID`, `P2R_CLIENT_SECRET`,
`P2R_PLATFORM`, and `ALLOWED_ORIGINS` in the host's environment-variable
settings. Never upload `.env` to the host. Confirm that the deployed `/health`
endpoint responds before using it in the game.

## Proxy behavior

- API URLs are normalized so `/api/v1` appears exactly once, whether
  `P2R_API_BASE_URL` is set to the API base or only the site origin.
- The game token is refreshed before its reported expiry (60 seconds early by
  default), with concurrent refreshes sharing one token request.
- A P2R 401 on a game-token route triggers exactly one token refresh and one
  retry. The proxy does not loop retries.
- Player `Authorization` headers are forwarded as received and are not cached.
- The public leaderboard route is forwarded without a game access token. A
  player bearer token is optional and is forwarded only so P2R can include
  `my_rank`.
- P2R response status, JSON body, and `Retry-After` header are passed back.
- Login, session start, spend, and complete have per-process safety limits of
  10, 30, 30, and 60 requests per minute. P2R remains the authoritative rate
  limiter, especially when the service has multiple instances.
- Leaderboard requests have a shared per-process limit of 120 per minute.
  The game loads them only when the leaderboard is opened, manually refreshed,
  paged, and once after a successful run; it does not poll automatically.
- Only the documented Lumina routes are forwarded; this is not an open proxy.

The browser must use HTTPS when the deployed game is served over HTTPS. Browsers
block requests from HTTPS pages to an HTTP proxy.
