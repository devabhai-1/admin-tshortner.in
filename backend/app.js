import express from 'express';
import cors from 'cors';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import {
  clearAuthCookie,
  credentialsConfigured,
  requireAuth,
  setAuthCookie,
  signAdminToken,
  verifyAdminCredentials,
  verifyAdminToken,
  extractToken,
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env then backend/.env (backend overrides)
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '32kb' }));

// Block probing of common sensitive paths
app.use((req, res, next) => {
  const p = (req.path || '').toLowerCase();
  if (
    p.includes('service_account') ||
    p.endsWith('.env') ||
    p.includes('node_modules') ||
    p.includes('/backend/')
  ) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// --- Config ---
const PROPERTY_ID = process.env.GA4_PROPERTY_ID || '469135333';
const GA4_DEFAULT_DAYS = parseInt(process.env.GA4_DEFAULT_DAYS || '5');
const GA4_LOOKBACK_DAYS = parseInt(process.env.GA4_LOOKBACK_DAYS || '1825');
const GA4_PAGE_SIZE = parseInt(process.env.GA4_PAGE_SIZE || '50000');
const GA4_MAX_RANGE_DAYS = parseInt(process.env.GA4_MAX_RANGE_DAYS || '0');
const GA_KEY_FILE = path.join(__dirname, 'service_account.json');
const FB_KEY_FILE = path.join(__dirname, 'service_account_key.json');
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://tshortner-in-default-rtdb.asia-southeast1.firebasedatabase.app';

// --- Firebase ---
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

let db;
try {
  let cred;
  const fbEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (fbEnv) {
    cred = JSON.parse(fbEnv);
  } else {
    const credPath = path.join(__dirname, 'service_account_key.json');
    if (fs.existsSync(credPath)) {
      cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    } else {
      console.warn("⚠ FIREBASE_SERVICE_ACCOUNT missing and no local file found. Firebase won't initialize.");
    }
  }
  
  if (cred) {
    if (cred.private_key) {
      cred.private_key = cred.private_key.replace(/\\n/g, '\n');
    }
    const app_firebase = initializeApp({
      credential: cert(cred),
      databaseURL: FIREBASE_DATABASE_URL
    });
    db = getDatabase(app_firebase);
    console.log("✅ Firebase connected");
  }
} catch (e) {
  if (e.code === 'app/duplicate-app') {
    db = getDatabase();
    console.log("✅ Firebase connected (already initialized)");
  } else {
    console.error("❌ Firebase failed:", e);
  }
}

// --- GA4 ---
let gaClient;
try {
  const gaEnv = process.env.GA4_SERVICE_ACCOUNT;
  if (gaEnv) {
    const gaCred = JSON.parse(gaEnv);
    if (gaCred.private_key) {
      gaCred.private_key = gaCred.private_key.replace(/\\n/g, '\n');
    }
    gaClient = new BetaAnalyticsDataClient({
      credentials: {
        client_email: gaCred.client_email,
        private_key: gaCred.private_key
      }
    });
    console.log("✅ GA4 client initialized");
  } else {
    const gaPath = path.join(__dirname, 'service_account.json');
    if (fs.existsSync(gaPath)) {
      gaClient = new BetaAnalyticsDataClient({ keyFilename: gaPath });
      console.log("✅ GA4 client initialized");
    } else {
      console.warn("⚠ GA4_SERVICE_ACCOUNT missing and no local file found. GA4 won't initialize.");
    }
  }
} catch (e) {
  console.error("❌ GA4 client init failed:", e);
}

// --- Helpers ---
function normalizeId(val) {
  if (!val) return null;
  val = val.trim().toLowerCase();
  val = val.replace(/^\/+/, '').replace(/\/+$/, '');
  val = val.replace('pages/', '').replace('al/', '');
  val = val.split('?')[0];
  return val;
}

function extractLinkId(path) {
  if (!path) return null;
  path = path.trim().toLowerCase();
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  path = path.split('?')[0];
  path = path.replace('pages/', '').replace('al/', '');
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function parseIsoDate(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  const parts = s.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function decodeEmailKey(key) {
  if (!key) return '';
  if (key.includes(',')) return key.replace(/,/g, '.');
  return key.replace(/_/g, '.');
}

function collectLinkCodesFromUser(user) {
  const codes = new Set();
  const links = user.links || {};
  for (const channel of ['telegram', 'website']) {
    const lst = (links[channel] || {}).list || {};
    if (typeof lst === 'object') {
      for (const itemId in lst) {
        const item = lst[itemId];
        if (typeof item === 'object') {
          const code = normalizeId(item.code);
          if (code) codes.add(code);
        }
      }
    }
  }
  const legacy = (user.shortner || {}).telegram || {};
  if (typeof legacy === 'object') {
    for (const linkId in legacy) {
      const lid = normalizeId(linkId);
      if (lid) codes.add(lid);
    }
  }
  return codes;
}

async function fetchWithRetry(url, retries = 2, delayMs = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Connection': 'keep-alive',
          'Accept': 'application/json'
        }
      });
      if (res.ok) return res;
      console.warn(`⚠ Fetch attempt ${i + 1} status ${res.status} for ${url}. Retrying...`);
    } catch (e) {
      if (i === retries) throw e;
      console.warn(`⚠ Fetch attempt ${i + 1} failed for ${url}: ${e.message}. Retrying...`);
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Fetch failed after ${retries} retries for ${url}`);
}

async function firebaseMappingFromAllLinks(allLinks) {
  const mapping = {};
  for (const code in allLinks || {}) {
    const meta = allLinks[code];
    if (!meta || typeof meta !== 'object') continue;
    const lid = normalizeId(code);
    if (!lid) continue;
    const usersOn = meta.users || {};
    for (const emailKey of Object.keys(usersOn)) {
      const email = decodeEmailKey(emailKey);
      if (!email) continue;
      if (!mapping[email]) mapping[email] = [];
      mapping[email].push({ id: lid, raw: String(code) });
    }
  }
  for (const email of Object.keys(mapping)) {
    const seen = new Set();
    mapping[email] = mapping[email].filter((ent) => {
      if (seen.has(ent.id)) return false;
      seen.add(ent.id);
      return true;
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return mapping;
}

async function firebaseMapping() {
  // Fast path for Vercel/SSE: only allLinks.json (users.json is huge and stalls the stream)
  try {
    const linksUrl = `${FIREBASE_DATABASE_URL}/allLinks.json`;
    console.log('Fetching Firebase allLinks via REST (fast map)...');
    const resLinks = await fetchWithRetry(linksUrl, 2, 1000);
    const allLinks = (await resLinks.json()) || {};
    const mapping = await firebaseMappingFromAllLinks(allLinks);
    console.log(`Fast Firebase map ready (${Object.keys(mapping).length} emails)`);
    return mapping;
  } catch (e) {
    console.warn('⚠ Fast allLinks map failed:', e.message);
  }

  // Fallback: Admin SDK allLinks only
  try {
    if (!db) throw new Error('Firebase Admin DB not initialized');
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase Timeout')), ms));
    const snap = await Promise.race([db.ref('allLinks').once('value'), timeout(12000)]);
    const allLinks = snap.val() || {};
    const mapping = await firebaseMappingFromAllLinks(allLinks);
    console.log(`Admin SDK allLinks map ready (${Object.keys(mapping).length} emails)`);
    return mapping;
  } catch (e) {
    console.error('❌ Firebase mapping error/timeout:', e.message);
    return {};
  }
}
const FB_MAP_CACHE = { at: 0, data: null };
const FB_MAP_TTL_SEC = parseFloat(process.env.FIREBASE_MAP_CACHE_SEC || '120');
let FB_MAP_PROMISE = null;

async function firebaseMappingCached(forceRefresh = false) {
  const now = Date.now() / 1000;
  if (!forceRefresh && FB_MAP_CACHE.data && (now - FB_MAP_CACHE.at) < FB_MAP_TTL_SEC) {
    return FB_MAP_CACHE.data;
  }

  if (FB_MAP_PROMISE) {
    console.log("🔗 Reusing in-progress Firebase mapping fetch...");
    return FB_MAP_PROMISE;
  }

  FB_MAP_PROMISE = firebaseMapping().then(data => {
    FB_MAP_CACHE.at = Date.now() / 1000;
    FB_MAP_CACHE.data = data;
    FB_MAP_PROMISE = null;
    return data;
  }).catch(err => {
    FB_MAP_PROMISE = null;
    throw err;
  });

  return FB_MAP_PROMISE;
}

function linkIdToEmailLookup(fbMap) {
  const out = {};
  for (const email in fbMap) {
    for (const ent of fbMap[email]) {
      const lid = ent.id;
      if (lid && !out[lid]) {
        out[lid] = email;
      }
    }
  }
  return out;
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


async function runGa4Report(startDateStr, endDateStr) {
  const allRows = [];
  const pageSize = Math.max(1, Math.min(GA4_PAGE_SIZE, 250000));
  let totalExpected = null;
  let pages = 0;
  let complete = true;
  let lastError = null;
  let offset = 0;

  while (true) {
    try {
      const [response] = await gaClient.runReport({
        property: `properties/${PROPERTY_ID}`,
        dimensions: [{ name: 'date' }, { name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
        limit: pageSize,
        offset: offset,
      });

      pages++;
      if (totalExpected === null) {
          totalExpected = response.rowCount ? parseInt(response.rowCount, 10) : 0;
      }

      const batch = response.rows || [];
      if (batch.length === 0) break;

      allRows.push(...batch);
      offset += batch.length;

      if (totalExpected && allRows.length >= totalExpected) break;
      if (batch.length < pageSize) break;

    } catch (e) {
      lastError = e;
      complete = false;
      break;
    }
  }

  return {
      allRows,
      totalExpected: totalExpected || allRows.length,
      pages,
      complete,
      error: lastError ? lastError.message : ""
  };
}

function rowsToOutput(gaRows, lidLookup, rawMode) {
    const out = [];
    for (const r of gaRows) {
        const rawDate = r.dimensionValues[0].value;
        const pagePath = r.dimensionValues[1].value;
        const views = parseInt(r.metricValues[0].value, 10);

        const readableDate = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6)}`;
        const linkId = normalizeId(extractLinkId(pagePath));

        if (rawMode) {
            const matchedEmail = linkId ? lidLookup[linkId] : null;
            if (!linkId && !pagePath) continue;
            out.push({
                date: readableDate,
                email: matchedEmail || "",
                pagePath: pagePath || "",
                linkId: linkId || "",
                views: views
            });
            continue;
        }

        if (!linkId) continue;
        const matchedEmail = lidLookup[linkId];
        out.push({
            date: readableDate,
            email: matchedEmail || "",
            linkId: linkId,
            pagePath: pagePath,
            views: views,
            matched: !!matchedEmail
        });
    }
    return out;
}

// --- Auth routes (public) ---
const loginFailMemory = new Map() // key -> { count, day }

function memoryFailKey(day, ip) {
    return `${day}:${ip}`
}

function getMemoryFails(day, ip) {
    const key = memoryFailKey(day, ip)
    const row = loginFailMemory.get(key)
    if (!row || row.day !== day) return 0
    return row.count || 0
}

function setMemoryFails(day, ip, count) {
    loginFailMemory.set(memoryFailKey(day, ip), { day, count })
}

function clearMemoryFails(day, ip) {
    loginFailMemory.delete(memoryFailKey(day, ip))
}

async function withTimeout(promise, ms, fallback) {
    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), ms)
            }),
        ])
    } catch {
        return fallback
    } finally {
        if (timer) clearTimeout(timer)
    }
}

app.post('/api/login', async (req, res) => {
    try {
        if (!credentialsConfigured()) {
            return res.status(503).json({
                success: false,
                error: 'Admin auth is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and JWT_SECRET in .env',
            });
        }

        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        if (Array.isArray(ip)) ip = ip[0];
        ip = String(ip).split(',')[0].trim();
        const safeIp = ip.replace(/[.#$[\]\s]/g, '_');

        const today = formatDate(new Date());
        let failedCount = getMemoryFails(today, safeIp);

        // Firebase rate-limit is best-effort only (never block login on RTDB hangs)
        if (db) {
            withTimeout(
                db.ref(`security/failed_logins/${today}/${safeIp}`).once('value').then((s) => {
                    const v = s.val() || 0
                    if (typeof v === 'number' && v > getMemoryFails(today, safeIp)) {
                        setMemoryFails(today, safeIp, v)
                    }
                }),
                2000,
                null,
            ).catch(() => {})
        }

        if (failedCount >= 10) {
            return res.status(429).json({
                success: false,
                error: 'Maximum attempts reached! Login is locked for today.',
            });
        }

        let ok = false;
        try {
            ok = verifyAdminCredentials(username, password);
        } catch (e) {
            return res.status(503).json({ success: false, error: e.message });
        }

        if (ok) {
            clearMemoryFails(today, safeIp);
            if (db) {
                withTimeout(db.ref(`security/failed_logins/${today}/${safeIp}`).remove(), 2000, null).catch(() => {})
            }

            const token = signAdminToken({ ip: safeIp });
            setAuthCookie(res, token);
            return res.json({ success: true, token });
        }

        const nextCount = failedCount + 1;
        setMemoryFails(today, safeIp, nextCount);
        if (db) {
            withTimeout(
                db.ref(`security/failed_logins/${today}/${safeIp}`).set(nextCount),
                2000,
                null,
            ).catch(() => {})
        }

        const remaining = 10 - nextCount;
        return res.status(401).json({
            success: false,
            error:
                remaining > 0
                    ? `Invalid credentials. ${remaining} attempts remaining.`
                    : 'Maximum attempts reached! Login is locked for today.',
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: 'Login failed' });
    }
});

app.get('/api/auth/me', (req, res) => {
    try {
        if (!credentialsConfigured()) {
            return res.status(503).json({ authenticated: false, error: 'Auth not configured' });
        }
        const token = extractToken(req);
        const payload = verifyAdminToken(token);
        if (!payload) {
            return res.status(401).json({ authenticated: false });
        }
        return res.json({
            authenticated: true,
            user: payload.sub || process.env.ADMIN_USERNAME,
            exp: payload.exp,
        });
    } catch (e) {
        return res.status(503).json({ authenticated: false, error: e.message });
    }
});

app.post('/api/logout', (req, res) => {
    clearAuthCookie(res);
    return res.json({ success: true });
});

// --- Protected API routes ---
app.use('/api', (req, res, next) => {
    // Public auth endpoints (already registered above; skip if somehow reached)
    const p = req.path || ''
    if (p === '/login' || p === '/auth/me' || p === '/logout' || p.endsWith('/login') || p.endsWith('/auth/me') || p.endsWith('/logout')) {
        return next();
    }
    return requireAuth(req, res, next);
});

app.get('/api/analytics', async (req, res) => {
    try {
        if (!gaClient) {
            return res.status(500).json({ error: "GA4 client not initialized" });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let isStreamActive = true;
        req.on('close', () => { isStreamActive = false; });
        res.on('error', (err) => { console.error("Stream error:", err); isStreamActive = false; });

        function emit(event, data) {
            if (!isStreamActive) return;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch(e) {
                isStreamActive = false;
            }
        }

        const forceFb = req.query.refresh_map === "1";
        const rawMode = req.query.mode === "raw";
        const today = new Date();
        let endDate = new Date(today);
        let startDate;
        let unlimitedDays = false;

        const daysQs = (req.query.days || "").trim().toLowerCase();
        
        if (['all', '0', 'unlimited', '-1'].includes(daysQs) || (!daysQs && GA4_DEFAULT_DAYS <= 0)) {
            unlimitedDays = true;
            startDate = new Date(today);
            startDate.setDate(today.getDate() - Math.max(GA4_LOOKBACK_DAYS - 1, 0));
        } else if (daysQs && !req.query.start_date) {
            const nDays = Math.max(1, parseInt(daysQs, 10));
            if (!isNaN(nDays)) {
                startDate = new Date(today);
                startDate.setDate(today.getDate() - (nDays - 1));
            } else {
                startDate = new Date(today);
                startDate.setDate(today.getDate() - Math.max(GA4_DEFAULT_DAYS - 1, 0));
            }
        } else {
            startDate = new Date(today);
            startDate.setDate(today.getDate() - (GA4_DEFAULT_DAYS > 0 ? Math.max(GA4_DEFAULT_DAYS - 1, 0) : GA4_LOOKBACK_DAYS - 1));
            if (GA4_DEFAULT_DAYS <= 0) unlimitedDays = true;
        }

        const qsStart = req.query.start_date;
        const qsEnd = req.query.end_date;
        if (qsStart && qsEnd) {
            const pStart = parseIsoDate(qsStart);
            const pEnd = parseIsoDate(qsEnd);
            if (pStart && pEnd) {
                startDate = new Date(Math.min(pStart.getTime(), pEnd.getTime()));
                endDate = new Date(Math.max(pStart.getTime(), pEnd.getTime()));
                unlimitedDays = false;
            } else {
                return res.status(400).json({ error: "Invalid start_date or end_date (use YYYY-MM-DD)" });
            }
        }

        if (endDate.getTime() > today.getTime()) endDate = new Date(today);
        if (startDate.getTime() > today.getTime()) startDate = new Date(today);

        if (GA4_MAX_RANGE_DAYS > 0 && (endDate.getTime() - startDate.getTime()) / (1000 * 3600 * 24) > GA4_MAX_RANGE_DAYS) {
            return res.status(400).json({
                error: `Date range too large (max ${GA4_MAX_RANGE_DAYS} days)`,
                start_date: formatDate(startDate),
                end_date: formatDate(endDate)
            });
        }

        const startS = formatDate(startDate);
        const endS = formatDate(endDate);

        const fbMap = await firebaseMappingCached(forceFb);
        const { allRows, totalExpected, pages, complete, error } = await runGa4Report(startS, endS);
        const lidLookup = linkIdToEmailLookup(fbMap);
        
        const output = [];
        for (const r of allRows) {
            const rawDate = r.dimensionValues[0].value;
            const pagePath = r.dimensionValues[1].value;
            const views = parseInt(r.metricValues[0].value, 10);

            const readableDate = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6)}`;
            const linkId = normalizeId(extractLinkId(pagePath));

            if (rawMode) {
                const matchedEmail = linkId ? lidLookup[linkId] : null;
                if (!linkId && !pagePath) continue;
                output.push({
                    date: readableDate,
                    email: matchedEmail || "",
                    pagePath: pagePath || "",
                    linkId: linkId || "",
                    views: views
                });
                continue;
            }

            if (!linkId) continue;
            const matchedEmail = lidLookup[linkId];
            if (matchedEmail) {
                output.push({ date: readableDate, email: matchedEmail, views: views });
            }
        }

        return res.json({
            rows: output,
            meta: {
                start_date: startS,
                end_date: endS,
                unlimited_days: unlimitedDays,
                ga4_rows_expected: totalExpected,
                ga4_rows_fetched: allRows.length,
                ga4_pages: pages,
                ga4_complete: complete,
                ga4_error: error,
                output_rows: output.length,
                raw_mode: rawMode
            }
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/analytics/stream', async (req, res) => {
    try {
        if (!gaClient) {
            return res.status(500).json({ error: "GA4 client not initialized" });
        }

        const forceFb = req.query.refresh_map === "1";
        const rawMode = req.query.mode === "raw";
        const today = new Date();
        let endDate = new Date(today);
        let startDate;
        let unlimitedDays = false;

        const daysQs = (req.query.days || "").trim().toLowerCase();
        
        if (['all', '0', 'unlimited', '-1'].includes(daysQs) || (!daysQs && GA4_DEFAULT_DAYS <= 0)) {
            unlimitedDays = true;
            startDate = new Date(today);
            startDate.setDate(today.getDate() - Math.max(GA4_LOOKBACK_DAYS - 1, 0));
        } else if (daysQs && !req.query.start_date) {
            const nDays = Math.max(1, parseInt(daysQs, 10));
            if (!isNaN(nDays)) {
                startDate = new Date(today);
                startDate.setDate(today.getDate() - (nDays - 1));
            } else {
                startDate = new Date(today);
                startDate.setDate(today.getDate() - Math.max(GA4_DEFAULT_DAYS - 1, 0));
            }
        } else {
            startDate = new Date(today);
            startDate.setDate(today.getDate() - (GA4_DEFAULT_DAYS > 0 ? Math.max(GA4_DEFAULT_DAYS - 1, 0) : GA4_LOOKBACK_DAYS - 1));
            if (GA4_DEFAULT_DAYS <= 0) unlimitedDays = true;
        }

        const qsStart = req.query.start_date;
        const qsEnd = req.query.end_date;
        if (qsStart && qsEnd) {
            const pStart = parseIsoDate(qsStart);
            const pEnd = parseIsoDate(qsEnd);
            if (pStart && pEnd) {
                startDate = new Date(Math.min(pStart.getTime(), pEnd.getTime()));
                endDate = new Date(Math.max(pStart.getTime(), pEnd.getTime()));
                unlimitedDays = false;
            } else {
                return res.status(400).json({ error: "Invalid start_date or end_date (use YYYY-MM-DD)" });
            }
        }

        if (endDate.getTime() > today.getTime()) endDate = new Date(today);
        if (startDate.getTime() > today.getTime()) startDate = new Date(today);

        const startS = formatDate(startDate);
        const endS = formatDate(endDate);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let isStreamActive = true;
        req.on('close', () => { isStreamActive = false; });
        res.on('error', (err) => { console.error("Stream error:", err); isStreamActive = false; });

        const emit = (event, payload) => {
            if (!isStreamActive) return;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch (e) {
                isStreamActive = false;
            }
        };

        emit("start", {
            start_date: startS,
            end_date: endS,
            unlimited_days: unlimitedDays,
            raw_mode: rawMode,
            page_size: Math.max(1, Math.min(GA4_PAGE_SIZE, 250000))
        });

        emit("progress", { phase: "mapping", message: "Loading Firebase link map…" });
        const heartbeat = setInterval(() => {
            emit("progress", { phase: "mapping", message: "Still loading map…" });
        }, 4000);
        let fbMap = {};
        try {
            fbMap = await firebaseMappingCached(forceFb);
        } finally {
            clearInterval(heartbeat);
        }
        const lidLookup = linkIdToEmailLookup(fbMap);
        emit("progress", {
            phase: "ga4",
            message: "Fetching GA4…",
            map_emails: Object.keys(fbMap || {}).length
        });

        let fetchedGaRowsCount = 0;
        let outputRowsCount = 0;
        let totalExpected = null;
        let pages = 0;
        let lastError = "";
        let offset = 0;
        const pageSize = Math.max(1, Math.min(GA4_PAGE_SIZE, 250000));

        while (true) {
            if (!isStreamActive) break;
            try {
                const [response] = await gaClient.runReport({
                    property: `properties/${PROPERTY_ID}`,
                    dimensions: [{ name: 'date' }, { name: 'pagePath' }],
                    metrics: [{ name: 'screenPageViews' }],
                    dateRanges: [{ startDate: startS, endDate: endS }],
                    limit: pageSize,
                    offset: offset,
                });

                if (!isStreamActive) break;

                pages++;
                if (totalExpected === null) {
                    totalExpected = response.rowCount ? parseInt(response.rowCount, 10) : 0;
                }

                const batch = response.rows || [];
                if (batch.length === 0) break;

                fetchedGaRowsCount += batch.length;
                offset += batch.length;

                const outBatch = rowsToOutput(batch, lidLookup, rawMode);
                if (outBatch.length > 0) {
                    outputRowsCount += outBatch.length;
                    emit("rows", {
                        rows: outBatch,
                        meta: {
                            ga4_rows_expected: totalExpected,
                            ga4_rows_fetched: fetchedGaRowsCount,
                            ga4_pages: pages,
                            output_rows: outputRowsCount
                        }
                    });
                }

                emit("progress", {
                    ga4_rows_expected: totalExpected,
                    ga4_rows_fetched: fetchedGaRowsCount,
                    ga4_pages: pages,
                    output_rows: outputRowsCount
                });

                if (totalExpected && fetchedGaRowsCount >= totalExpected) break;
                if (batch.length < pageSize) break;

            } catch (e) {
                lastError = e.message;
                emit("error", { message: lastError });
                break;
            }
        }

        const gaComplete = (totalExpected === null) || (fetchedGaRowsCount >= totalExpected);
        emit("done", {
            rows: [], // Returning empty rows at the end to prevent memory spikes since they were already streamed
            meta: {
                start_date: startS,
                end_date: endS,
                unlimited_days: unlimitedDays,
                ga4_rows_expected: totalExpected || fetchedGaRowsCount,
                ga4_rows_fetched: fetchedGaRowsCount,
                ga4_pages: pages,
                ga4_complete: gaComplete,
                ga4_error: lastError,
                output_rows: outputRowsCount,
                raw_mode: rawMode
            }
        });

        res.end();

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        ga4: !!gaClient,
        firebase: !!db,
        property_id: PROPERTY_ID
    });
});


// Vercel serverless: do not call listen() - export the app only.
const isServerless = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV)
if (!isServerless) {
  const PORT = process.env.PORT || 5005
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Listening http://0.0.0.0:${PORT} (cwd keys: ${__dirname})`)
  })
}

export default app
