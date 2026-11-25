"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");

const app = express();
const config = {
  port: Number(process.env.PORT || 3000),
  apiBaseUrl: (process.env.P2R_API_BASE_URL || "https://pameran.devsaka.id/api/v1").replace(/\/+$/, ""),
  gameSlug: process.env.P2R_GAME_SLUG || "lumina-adventure",
  clientId: process.env.P2R_CLIENT_ID || "",
  clientSecret: process.env.P2R_CLIENT_SECRET || "",
  platform: process.env.P2R_PLATFORM || "web",
  refreshMarginMs: Number(process.env.GAME_TOKEN_REFRESH_MARGIN_SECONDS || 60) * 1000,
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 15000),
  allowedOrigins: new Set(
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  )
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!Number.isFinite(config.refreshMarginMs) || config.refreshMarginMs < 0) {
  throw new Error("GAME_TOKEN_REFRESH_MARGIN_SECONDS must be zero or a positive number.");
}
if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000) {
  throw new Error("UPSTREAM_TIMEOUT_MS must be at least 1000.");
}
if (config.gameSlug !== "lumina-adventure") {
  throw new Error("This proxy only supports the configured Lumina Adventure game slug.");
}

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb", strict: true }));

class UpstreamFailure extends Error {
  constructor(status, body, headers) {
    super("P2R API request failed.");
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

class ProxyConfigurationFailure extends Error {}

let cachedGameToken = null;
let tokenRequestInFlight = null;
const rateBuckets = new Map();
const rateLimits = {
  login: 10,
  start: 30,
  spend: 30,
  complete: 60,
  leaderboard: 120
};

function cors(req, res, next) {
  const origin = req.get("Origin");
  if (origin && !config.allowedOrigins.has(origin)) {
    return res.status(403).json({
      success: false,
      error_code: "ORIGIN_NOT_ALLOWED",
      message: "Alamat game ini belum diizinkan oleh server."
    });
  }

  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Expose-Headers", "Retry-After");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
}

app.use(cors);

function p2rApiUrl(path) {
  const configuredBase = config.apiBaseUrl.replace(/\/+$/, "");
  const apiBase = /\/api\/v1$/i.test(configuredBase)
    ? configuredBase
    : `${configuredBase}/api/v1`;
  const apiPath = String(path).replace(/^\/?api\/v1(?=\/|$)/i, "");
  return `${apiBase}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
}

function parseExpiresAt(data) {
  const absoluteExpiry = Date.parse(data.expires_at);
  if (Number.isFinite(absoluteExpiry)) {
    return absoluteExpiry;
  }

  const expiresInSeconds = Number.parseFloat(data.expires_in);
  if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1000;
  }

  throw new Error("P2R token response did not contain a usable expiry.");
}

async function exchangeGameToken() {
  if (!config.clientId || !config.clientSecret) {
    throw new ProxyConfigurationFailure();
  }

  let response;
  try {
    response = await fetch(
      p2rApiUrl(`/games/${encodeURIComponent(config.gameSlug)}/auth/token`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          platform: config.platform
        }),
        signal: AbortSignal.timeout(config.timeoutMs)
      }
    );
  } catch (error) {
    const status = error.name === "TimeoutError" ? 504 : 502;
    throw new UpstreamFailure(status, {
      success: false,
      error_code: status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      message: status === 504
        ? "Server P2R terlalu lama merespons. Coba lagi sebentar."
        : "Server P2R tidak dapat dijangkau. Periksa koneksi lalu coba lagi."
    });
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new UpstreamFailure(502, {
      success: false,
      error_code: "INVALID_UPSTREAM_RESPONSE",
      message: "Server P2R mengirim jawaban yang tidak dapat dibaca."
    });
  }

  if (!response.ok) {
    throw new UpstreamFailure(response.status, body, {
      retryAfter: response.headers.get("Retry-After")
    });
  }

  const data = body && body.data;
  if (!body || body.success !== true || !data || typeof data.access_token !== "string") {
    throw new UpstreamFailure(502, {
      success: false,
      error_code: "INVALID_UPSTREAM_RESPONSE",
      message: "Server P2R belum memberikan token game yang valid."
    });
  }

  cachedGameToken = {
    value: data.access_token,
    refreshAt: parseExpiresAt(data) - config.refreshMarginMs
  };
  return cachedGameToken.value;
}

async function getGameToken() {
  if (cachedGameToken && Date.now() < cachedGameToken.refreshAt) {
    return cachedGameToken.value;
  }
  if (!tokenRequestInFlight) {
    tokenRequestInFlight = exchangeGameToken().finally(() => {
      tokenRequestInFlight = null;
    });
  }
  return tokenRequestInFlight;
}

function parseRetryAfter(response) {
  const value = response.headers.get("Retry-After");
  if (value) {
    return value;
  }
  return null;
}

async function readUpstreamResponse(response) {
  const text = await response.text();
  return {
    status: response.status,
    text,
    contentType: response.headers.get("Content-Type") || "application/json; charset=utf-8",
    retryAfter: parseRetryAfter(response)
  };
}

async function callP2r(path, method, body, playerAuthorization, gameToken) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (playerAuthorization) {
    headers.Authorization = playerAuthorization;
  }
  if (gameToken) {
    headers["X-Game-Access-Token"] = gameToken;
  }

  let response;
  try {
    response = await fetch(p2rApiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const status = error.name === "TimeoutError" ? 504 : 502;
    throw new UpstreamFailure(status, {
      success: false,
      error_code: status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      message: status === 504
        ? "Server P2R terlalu lama merespons. Coba lagi sebentar."
        : "Server P2R tidak dapat dijangkau. Periksa koneksi lalu coba lagi."
    });
  }

  return readUpstreamResponse(response);
}

function sendUpstreamResult(res, result) {
  res.status(result.status);
  res.set("Content-Type", result.contentType);
  if (result.retryAfter) {
    res.set("Retry-After", result.retryAfter);
  }
  return res.send(result.text);
}

function authHeader(req) {
  const value = req.get("Authorization");
  if (!value) {
    return null;
  }
  if (!/^Bearer\s+\S+$/i.test(value)) {
    return false;
  }
  return value;
}

function rateLimitKey(req, action) {
  if (action === "leaderboard") {
    return `${action}:${config.gameSlug}`;
  }
  const authorization = req.get("Authorization");
  const identity = authorization
    ? crypto.createHash("sha256").update(authorization).digest("hex")
    : req.ip;
  return `${action}:${identity}`;
}

function checkRateLimit(req, res, action) {
  const limit = rateLimits[action];
  if (!limit) {
    return true;
  }

  const now = Date.now();
  const key = rateLimitKey(req, action);
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    const retrySeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set("Retry-After", String(retrySeconds));
    res.status(429).json({
      success: false,
      error_code: "RATE_LIMIT_EXCEEDED",
      message: "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi."
    });
    return false;
  }
  bucket.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) {
      rateBuckets.delete(key);
    }
  }
}, 60_000).unref();

app.get("/health", (_req, res) => {
  res.json({ success: true, message: "Lumina P2R proxy is running." });
});

app.all("/api/v1/*", async (req, res) => {
  const path = req.originalUrl.split("?")[0];
  const url = new URL(req.originalUrl, "http://proxy.local");
  const query = url.search;
  const basePath = path;
  const gamePrefix = `/api/v1/games/${config.gameSlug}`;

  let upstreamPath;
  let requiresPlayer = false;
  let requiresGameToken = false;
  let rateAction = null;

  if (req.method === "POST" && basePath === "/api/v1/auth/login") {
    upstreamPath = `${basePath}${query}`;
    rateAction = "login";
  } else if (req.method === "POST" && basePath === "/api/v1/auth/logout") {
    upstreamPath = `${basePath}${query}`;
    requiresPlayer = true;
  } else if (req.method === "GET" && basePath === "/api/v1/me/wallet") {
    upstreamPath = `${basePath}${query}`;
    requiresPlayer = true;
  } else if (
    req.method === "GET" &&
    [gamePrefix, `${gamePrefix}/contract`, `${gamePrefix}/integration-status`, `${gamePrefix}/leaderboard`]
      .includes(basePath)
  ) {
    upstreamPath = `${basePath}${query}`;
    const publicLeaderboard = basePath === `${gamePrefix}/leaderboard`;
    requiresGameToken = !publicLeaderboard;
    if (publicLeaderboard) {
      rateAction = "leaderboard";
    }
  } else if (req.method === "POST" && basePath === `${gamePrefix}/sessions/start`) {
    upstreamPath = `${basePath}${query}`;
    requiresPlayer = true;
    requiresGameToken = true;
    rateAction = "start";
  } else if (req.method === "POST" && basePath === `${gamePrefix}/economy/spend`) {
    upstreamPath = `${basePath}${query}`;
    requiresPlayer = true;
    requiresGameToken = true;
    rateAction = "spend";
  } else if (
    req.method === "POST" &&
    new RegExp(`^${gamePrefix}/sessions/[A-Za-z0-9._~-]+/complete$`).test(basePath)
  ) {
    upstreamPath = `${basePath}${query}`;
    requiresPlayer = true;
    requiresGameToken = true;
    rateAction = "complete";
  } else {
    return res.status(404).json({
      success: false,
      error_code: "PROXY_ROUTE_NOT_FOUND",
      message: "Rute API ini tidak tersedia melalui proxy."
    });
  }

  if (rateAction && !checkRateLimit(req, res, rateAction)) {
    return;
  }

  let authorization;
  if (requiresPlayer) {
    authorization = authHeader(req);
    if (!authorization) {
      return res.status(401).json({
        success: false,
        error_code: "UNAUTHENTICATED",
        message: "Silakan login kembali untuk melanjutkan."
      });
    }
    if (authorization === false) {
      return res.status(400).json({
        success: false,
        error_code: "INVALID_AUTHORIZATION_HEADER",
        message: "Format token pemain tidak valid."
      });
    }
  } else {
    authorization = authHeader(req);
    if (authorization === false) {
      return res.status(400).json({
        success: false,
        error_code: "INVALID_AUTHORIZATION_HEADER",
        message: "Format token pemain tidak valid."
      });
    }
  }

  try {
    let gameToken = requiresGameToken ? await getGameToken() : null;
    let result = await callP2r(
      upstreamPath,
      req.method,
      req.method === "GET" ? undefined : req.body,
      authorization || null,
      gameToken
    );

    if (requiresGameToken && result.status === 401) {
      if (cachedGameToken && cachedGameToken.value === gameToken) {
        cachedGameToken = null;
      }
      gameToken = await getGameToken();
      result = await callP2r(
        upstreamPath,
        req.method,
        req.method === "GET" ? undefined : req.body,
        authorization || null,
        gameToken
      );
    }

    return sendUpstreamResult(res, result);
  } catch (error) {
    if (error instanceof UpstreamFailure) {
      if (error.headers && error.headers.retryAfter) {
        res.set("Retry-After", error.headers.retryAfter);
      }
      const body = typeof error.body === "string"
        ? error.body
        : JSON.stringify(error.body);
      res.status(error.status).type("application/json").send(body);
      return;
    }
    if (error instanceof ProxyConfigurationFailure) {
      console.error("P2R proxy credentials are not configured.");
      res.status(503).json({
        success: false,
        error_code: "PROXY_NOT_CONFIGURED",
        message: "Server belum dikonfigurasi. Admin perlu mengisi kredensial P2R di .env."
      });
      return;
    }

    console.error("P2R proxy request failed:", error.message);
    res.status(503).json({
      success: false,
      error_code: "PROXY_CONFIGURATION_ERROR",
      message: "Proxy belum siap. Periksa konfigurasi server."
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, "body")) {
    return res.status(400).json({
      success: false,
      error_code: "INVALID_JSON",
      message: "Data permintaan tidak terbaca."
    });
  }
  console.error("P2R proxy internal error:", error.message);
  return res.status(500).json({
    success: false,
    error_code: "PROXY_INTERNAL_ERROR",
    message: "Server perantara mengalami gangguan."
  });
});

app.listen(config.port, () => {
  console.log(`Lumina P2R proxy listening on port ${config.port}.`);
});
