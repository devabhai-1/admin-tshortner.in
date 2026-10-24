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
import { getCountryCpm } from './admanagerCpm.js';

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

function extractLinkIdRaw(path) {
  if (!path) return '';
  let clean = String(path).trim().split('?')[0].replace(/^\/+|\/+$/g, '');
  clean = clean.replace(/^pages\//i, '').replace(/^al\//i, '');
  const parts = clean.split('/').filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  const id = last.match(/[A-Za-z0-9_-]{6,}/);
  return id ? id[0] : last;
}

function extractLinkId(path) {
  const raw = extractLinkIdRaw(path);
  return raw ? raw.toLowerCase() : null;
}

/** Site chrome / non-short URLs — inko "Mail not linked" me mat gino */
const NON_LINK_PATH_TOKENS = new Set([
  '', 'home', 'index', 'login', 'signup', 'register', 'player', 'watch', 'api',
  'admin', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'about', 'privacy',
  'terms', 'contact', 'dashboard', 'redirect', 'go', 'r', 'www', 'static',
  'assets', 'css', 'js', 'img', 'images', 'null', 'undefined',
]);

function isLikelyShortCode(id) {
  if (!id) return false;
  const s = String(id).trim().toLowerCase();
  if (NON_LINK_PATH_TOKENS.has(s)) return false;
  if (s.includes('.') && !s.includes('@')) return false; // file.ext
  return /^[a-z0-9_-]{5,40}$/.test(s);
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

/** linkId → [emails] for /pages mail rollup (fast, no per-code HTTP) */
function linkIdToEmailsLookup(fbMap) {
  const out = {};
  for (const email in fbMap) {
    for (const ent of fbMap[email] || []) {
      const lid = ent?.id;
      if (!lid) continue;
      if (!out[lid]) out[lid] = [];
      if (!out[lid].includes(email)) out[lid].push(email);
    }
  }
  return out;
}

const PAGES_API_CACHE = new Map();
const PAGES_API_TTL_MS = Math.max(15000, Number(process.env.PAGES_API_CACHE_MS || 90000));

function pagesCacheGet(key) {
  const hit = PAGES_API_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PAGES_API_TTL_MS) {
    PAGES_API_CACHE.delete(key);
    return null;
  }
  return hit.body;
}

function pagesCacheSet(key, body) {
  PAGES_API_CACHE.set(key, { at: Date.now(), body });
  if (PAGES_API_CACHE.size > 40) {
    const oldest = [...PAGES_API_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) PAGES_API_CACHE.delete(oldest[0]);
  }
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

async function ownersForBatch(gaRows) {
  const rawByNorm = new Map();
  for (const row of gaRows) {
    const raw = extractLinkIdRaw(row.dimensionValues?.[1]?.value || '');
    const norm = normalizeId(raw);
    if (norm && !rawByNorm.has(norm)) rawByNorm.set(norm, raw);
  }
  const found = await lookupOwners([...rawByNorm.values()], {
    deadlineMs: 4000,
    concurrency: 36,
    fetchMs: 1500,
  });
  const lidLookup = {};
  for (const [norm, raw] of rawByNorm) {
    const emails = found.get(raw) || [];
    if (emails[0]) lidLookup[norm] = emails[0];
  }
  return lidLookup;
}

function isoDaysBetween(startS, endS) {
  const days = [];
  let cur = startS;
  while (cur && cur <= endS && days.length < 8) {
    days.push(cur);
    const [y, m, d] = cur.split('-').map(Number);
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  return days;
}

async function loadRealtimeEmails(startS, endS) {
  const map = new Map();
  for (const day of isoDaysBetween(startS, endS)) {
    try {
      const res = await fetch(`${FIREBASE_DATABASE_URL}/realtimeTraffic/days/${day}/links.json`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const links = await res.json();
      if (!links || typeof links !== 'object') continue;
      for (const [code, row] of Object.entries(links)) {
        const email = row && typeof row.email === 'string' ? row.email.trim() : '';
        if (!email.includes('@')) continue;
        const rawKey = String(code).toLowerCase();
        const loose = looseLinkId(code).toLowerCase();
        if (!map.has(rawKey)) map.set(rawKey, email);
        if (loose && !map.has(loose)) map.set(loose, email);
      }
    } catch (err) {
      console.error('realtime emails', day, err.message);
    }
  }
  return map;
}

async function pullGaPages({ startS, endS, rawMode, pageSize = 10000, maxMs = 50000, onBatch, refreshMap = false }) {
  const started = Date.now();
  let offset = 0;
  let totalExpected = null;
  let pages = 0;
  let fetched = 0;
  let outputCount = 0;
  let viewTotal = 0;
  let lastError = '';
  const gaRows = [];
  while (Date.now() - started < maxMs) {
    let response;
    try {
      const result = await Promise.race([
        gaClient.runReport({
          property: `properties/${PROPERTY_ID}`,
          dimensions: [{ name: 'date' }, { name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }],
          dateRanges: [{ startDate: startS, endDate: endS }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: pageSize,
          offset,
          metricAggregations: ['TOTAL'],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GA4 report timed out')), 20000)),
      ]);
      response = result[0];
    } catch (e) {
      lastError = e.message || 'GA4 report failed';
      break;
    }
    pages += 1;
    if (totalExpected === null) {
      totalExpected = Number(response.rowCount || 0);
      const totalMetric = response.totals?.[0]?.metricValues?.[0]?.value;
      if (totalMetric != null) viewTotal = Number(totalMetric) || 0;
    }
    const batch = response.rows || [];
    if (!batch.length) break;
    gaRows.push(...batch);
    fetched += batch.length;
    offset += batch.length;
    if ((totalExpected && fetched >= totalExpected) || batch.length < pageSize) break;
  }
  const complete = !totalExpected || fetched >= totalExpected;
  if (!complete && !lastError) {
    lastError = `Incomplete: ${fetched} / ${totalExpected} pages loaded`;
  }

  // Full allLinks map first (avoids timeout → huge "Mail not linked")
  let lidLookup = {};
  try {
    lidLookup = linkIdToEmailLookup(await firebaseMappingCached(!!refreshMap)) || {};
  } catch (e) {
    console.warn('firebase map for GA pull:', e.message);
  }

  const realtimeEmails = await loadRealtimeEmails(startS, endS);
  for (const [norm, email] of realtimeEmails) {
    if (norm && email && !lidLookup[norm]) lidLookup[norm] = email;
  }

  const viewByCode = new Map();
  for (const row of gaRows) {
    const raw = extractLinkIdRaw(row.dimensionValues?.[1]?.value || '');
    if (!raw || !isLikelyShortCode(normalizeId(raw) || raw)) continue;
    const views = Number(row.metricValues?.[0]?.value || 0);
    viewByCode.set(raw, (viewByCode.get(raw) || 0) + views);
  }
  const missing = [...viewByCode.keys()]
    .filter((raw) => !lidLookup[normalizeId(raw)])
    .sort((a, b) => viewByCode.get(b) - viewByCode.get(a));
  const remain = maxMs - (Date.now() - started);
  const budget = Math.min(22000, Math.max(0, remain - 4000));
  if (missing.length && budget > 2000) {
    await lookupOwners(missing, {
      deadlineMs: budget,
      concurrency: 40,
      fetchMs: 4000,
    });
    const retry = missing.filter((raw) => !OWNER_CACHE.has(raw));
    const after = maxMs - (Date.now() - started);
    if (retry.length && after > 4000) {
      await lookupOwners(retry, {
        deadlineMs: Math.min(after - 3000, 14000),
        concurrency: 24,
        fetchMs: 5000,
      });
    }
    for (const raw of missing) {
      const emails = OWNER_CACHE.get(raw) || [];
      const norm = normalizeId(raw);
      if (norm && emails[0]) lidLookup[norm] = emails[0];
    }
  }
  const afterLookup = maxMs - (Date.now() - started);
  const still = missing.filter((raw) => !lidLookup[normalizeId(raw)]).slice(0, 400);
  if (still.length && afterLookup > 3000) {
    const looseFound = await lookupLooseOwners(still, {
      deadlineMs: Math.min(afterLookup - 1500, 8000),
    });
    for (const [raw, emails] of looseFound) {
      const norm = normalizeId(raw);
      if (norm && emails[0]) lidLookup[norm] = emails[0];
    }
  }

  const chunk = 2000;
  for (let i = 0; i < gaRows.length; i += chunk) {
    const outBatch = rowsToOutput(gaRows.slice(i, i + chunk), lidLookup, rawMode);
    outputCount += outBatch.length;
    if (onBatch) {
      await onBatch(outBatch, { totalExpected, fetched, pages, outputCount, viewTotal });
    }
  }
  return { totalExpected: totalExpected || fetched, fetched, pages, outputCount, viewTotal, lastError, complete };
}

function rowsToOutput(gaRows, lidLookup, rawMode) {
    const out = [];
    for (const r of gaRows) {
        const rawDate = r.dimensionValues[0].value;
        const pagePath = r.dimensionValues[1].value;
        const views = parseInt(r.metricValues[0].value, 10);

        const readableDate = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6)}`;
        const linkId = normalizeId(extractLinkId(pagePath));
        const shortOk = isLikelyShortCode(linkId);

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

        // Homepage / player / non-short paths — allocation se bahar (Mail not linked inflate mat karo)
        if (!shortOk) continue;

        const matchedEmail = linkId ? lidLookup[linkId] : '';
        out.push({
            date: readableDate,
            email: matchedEmail || 'Mail not linked',
            linkId: linkId || '',
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
        const refreshMap = String(req.query.refresh_map || '') === '1';
        const output = [];
        const pulled = await pullGaPages({
            startS,
            endS,
            rawMode,
            refreshMap,
            pageSize: 10000,
            maxMs: 50000,
            onBatch: async (batch) => {
                output.push(...batch);
            },
        });

        return res.json({
            rows: output,
            meta: {
                start_date: startS,
                end_date: endS,
                unlimited_days: unlimitedDays,
                ga4_rows_expected: pulled.totalExpected,
                ga4_rows_fetched: pulled.fetched,
                ga4_pages: pulled.pages,
                ga4_complete: pulled.complete,
                ga4_error: pulled.lastError,
                ga4_views: pulled.viewTotal,
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

        emit("progress", { phase: "ga4", message: "Fetching GA4…" });

        const refreshMap = String(req.query.refresh_map || '') === '1';
        const pulled = await pullGaPages({
            startS,
            endS,
            rawMode,
            refreshMap,
            pageSize: 10000,
            maxMs: 52000,
            onBatch: async (outBatch, info) => {
                if (!isStreamActive || !outBatch.length) return;
                emit("rows", {
                    rows: outBatch,
                    meta: {
                        ga4_rows_expected: info.totalExpected,
                        ga4_rows_fetched: info.fetched,
                        ga4_pages: info.pages,
                        ga4_views: info.viewTotal,
                        output_rows: info.outputCount
                    }
                });
                emit("progress", {
                    ga4_rows_expected: info.totalExpected,
                    ga4_rows_fetched: info.fetched,
                    ga4_pages: info.pages,
                    ga4_views: info.viewTotal,
                    output_rows: info.outputCount
                });
            },
        });

        emit("done", {
            rows: [],
            meta: {
                start_date: startS,
                end_date: endS,
                unlimited_days: unlimitedDays,
                ga4_rows_expected: pulled.totalExpected,
                ga4_rows_fetched: pulled.fetched,
                ga4_pages: pulled.pages,
                ga4_complete: pulled.complete,
                ga4_error: pulled.lastError,
                ga4_views: pulled.viewTotal,
                output_rows: pulled.outputCount,
                raw_mode: rawMode
            }
        });

        res.end();

    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            try { res.end(); } catch { /* already closed */ }
            return;
        }
        res.status(500).json({ error: e.message });
    }
});

function numMetric(row, index) {
  const raw = row?.metricValues?.[index]?.value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function gaDateToIso(yyyymmdd) {
  const s = String(yyyymmdd || '');
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

const DEMO_METRICS = [
  'activeUsers',
  'newUsers',
  'engagedSessions',
  'engagementRate',
  'userEngagementDuration',
  'eventCount',
  'keyEvents',
  'userKeyEventRate',
  'totalRevenue',
];

async function runCountryReport(startDate, endDate) {
  const metrics = DEMO_METRICS.map((name) => ({ name }));
  try {
    const [response] = await gaClient.runReport({
      property: `properties/${PROPERTY_ID}`,
      dimensions: [{ name: 'country' }],
      metrics,
      dateRanges: [{ startDate, endDate }],
      metricAggregations: ['TOTAL'],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 250,
    });
    return response;
  } catch (err) {
    // Older properties may reject key-event metrics — retry without them.
    const fallback = DEMO_METRICS.filter((n) => n !== 'keyEvents' && n !== 'userKeyEventRate');
    const [response] = await gaClient.runReport({
      property: `properties/${PROPERTY_ID}`,
      dimensions: [{ name: 'country' }],
      metrics: fallback.map((name) => ({ name })),
      dateRanges: [{ startDate, endDate }],
      metricAggregations: ['TOTAL'],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 250,
    });
    response._metricNames = fallback;
    response._metricWarning = err.message;
    return response;
  }
}

app.get('/api/analytics/demographics', async (req, res) => {
  try {
    if (!gaClient) {
      return res.status(500).json({ error: 'GA4 client not initialized' });
    }

    const today = formatDate(new Date());
    const startDate = String(req.query.start_date || today).slice(0, 10);
    const endDate = String(req.query.end_date || startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date cannot be after end_date' });
    }

    const countryRes = await runCountryReport(startDate, endDate);
    const metricNames = countryRes._metricNames || DEMO_METRICS;
    const idx = Object.fromEntries(metricNames.map((name, i) => [name, i]));

    const mapRow = (row) => {
      const activeUsers = numMetric(row, idx.activeUsers);
      const engagedSessions = numMetric(row, idx.engagedSessions);
      const duration = numMetric(row, idx.userEngagementDuration);
      const engagementRate = numMetric(row, idx.engagementRate);
      const keyEvents = idx.keyEvents == null ? 0 : numMetric(row, idx.keyEvents);
      const userKeyEventRate = idx.userKeyEventRate == null ? 0 : numMetric(row, idx.userKeyEventRate);
      return {
        country: row.dimensionValues?.[0]?.value || '(not set)',
        activeUsers,
        newUsers: numMetric(row, idx.newUsers),
        engagedSessions,
        engagementRate,
        engagedSessionsPerActiveUser: activeUsers ? engagedSessions / activeUsers : 0,
        avgEngagementTime: activeUsers ? duration / activeUsers : 0,
        eventCount: numMetric(row, idx.eventCount),
        keyEvents,
        userKeyEventRate,
        totalRevenue: numMetric(row, idx.totalRevenue),
      };
    };

    const rows = (countryRes.rows || []).map(mapRow);
    const totalsRow = (countryRes.totals && countryRes.totals[0]) || null;
    const totals = totalsRow
      ? mapRow({ ...totalsRow, dimensionValues: [{ value: 'Total' }] })
      : rows.reduce(
          (acc, r) => {
            acc.activeUsers += r.activeUsers;
            acc.newUsers += r.newUsers;
            acc.engagedSessions += r.engagedSessions;
            acc.eventCount += r.eventCount;
            acc.keyEvents += r.keyEvents;
            acc.totalRevenue += r.totalRevenue;
            acc._duration += r.avgEngagementTime * r.activeUsers;
            return acc;
          },
          {
            country: 'Total',
            activeUsers: 0,
            newUsers: 0,
            engagedSessions: 0,
            eventCount: 0,
            keyEvents: 0,
            totalRevenue: 0,
            _duration: 0,
          },
        );

    if (!totalsRow) {
      totals.engagementRate = 0;
      totals.engagedSessionsPerActiveUser = totals.activeUsers
        ? totals.engagedSessions / totals.activeUsers
        : 0;
      totals.avgEngagementTime = totals.activeUsers ? totals._duration / totals.activeUsers : 0;
      totals.userKeyEventRate = totals.activeUsers ? totals.keyEvents / totals.activeUsers : 0;
    }
    delete totals._duration;
    totals.country = 'Total';

    const topCountries = rows.slice(0, 8).map((r) => r.country);
    const [seriesRes] = await gaClient.runReport({
      property: `properties/${PROPERTY_ID}`,
      dimensions: [{ name: 'date' }, { name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
      dateRanges: [{ startDate, endDate }],
      dimensionFilter: topCountries.length
        ? {
            filter: {
              fieldName: 'country',
              inListFilter: { values: topCountries },
            },
          }
        : undefined,
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 10000,
    });

    const seriesMap = new Map();
    for (const r of seriesRes.rows || []) {
      const date = gaDateToIso(r.dimensionValues?.[0]?.value);
      const country = r.dimensionValues?.[1]?.value || '(not set)';
      const users = Number(r.metricValues?.[0]?.value || 0);
      if (!seriesMap.has(date)) seriesMap.set(date, { date });
      seriesMap.get(date)[country] = users;
    }
    const series = Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      startDate,
      endDate,
      propertyId: PROPERTY_ID,
      totals,
      rows,
      series,
      seriesCountries: topCountries,
      warning: countryRes._metricWarning || '',
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Demographics report failed' });
  }
});

const PAGE_METRICS = [
  'screenPageViews',
  'activeUsers',
  'screenPageViewsPerUser',
  'userEngagementDuration',
  'eventCount',
  'keyEvents',
  'totalRevenue',
];

async function runPagesReport(startDate, endDate, { limit, offset, q, metrics }) {
  const names = metrics || PAGE_METRICS;
  const request = {
    property: `properties/${PROPERTY_ID}`,
    dimensions: [{ name: 'unifiedPagePathScreen' }],
    metrics: names.map((name) => ({ name })),
    dateRanges: [{ startDate, endDate }],
    metricAggregations: ['TOTAL'],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
    offset,
  };
  if (q) {
    request.dimensionFilter = {
      filter: {
        fieldName: 'unifiedPagePathScreen',
        stringFilter: { matchType: 'CONTAINS', value: q, caseSensitive: false },
      },
    };
  }
  try {
    const response = await Promise.race([
      gaClient.runReport(request).then((result) => result[0]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GA4 report timed out')), 18000)),
    ]);
    response._metricNames = names;
    return response;
  } catch (err) {
    if (names.includes('keyEvents')) {
      return runPagesReport(startDate, endDate, {
        limit,
        offset,
        q,
        metrics: names.filter((name) => name !== 'keyEvents'),
      });
    }
    throw err;
  }
}

/**
 * Mail rollup — keep under Vercel ~60s:
 * 1) Top pages from GA4 (not all 27k)
 * 2) realtimeTraffic email map (1 request/day — fast)
 * 3) only a small OWNER_CACHE fill for leftover top codes
 */
async function fetchAllPagesForMails(startDate, endDate, q) {
  const metrics = ['screenPageViews', 'activeUsers', 'totalRevenue'];
  const maxRows = Math.max(300, Math.min(1200, Number(process.env.PAGES_MAIL_TOP_ROWS || 800)));
  const report = await runPagesReport(startDate, endDate, {
    limit: maxRows,
    offset: 0,
    q,
    metrics,
  });
  const metricNames = report._metricNames || metrics;
  const idx = Object.fromEntries(metricNames.map((name, i) => [name, i]));
  const rowCount = Number(report.rowCount || 0);
  const mappedRows = (report.rows || []).map((row) => ({
    path: row.dimensionValues?.[0]?.value || '(not set)',
    views: numMetric(row, idx.screenPageViews),
    activeUsers: numMetric(row, idx.activeUsers),
    totalRevenue: numMetric(row, idx.totalRevenue),
  }));

  const totalsRow = report.totals?.[0];
  const totals = totalsRow
    ? {
        path: 'Total',
        views: numMetric(totalsRow, idx.screenPageViews),
        activeUsers: numMetric(totalsRow, idx.activeUsers),
        totalRevenue: numMetric(totalsRow, idx.totalRevenue),
        viewsPerUser: 0,
        avgEngagementTime: 0,
        eventCount: 0,
        keyEvents: 0,
      }
    : {
        path: 'Total',
        views: mappedRows.reduce((s, r) => s + r.views, 0),
        activeUsers: mappedRows.reduce((s, r) => s + r.activeUsers, 0),
        totalRevenue: mappedRows.reduce((s, r) => s + r.totalRevenue, 0),
        viewsPerUser: 0,
        avgEngagementTime: 0,
        eventCount: 0,
        keyEvents: 0,
      };

  let mailWarning = '';
  let realtimeEmails = new Map();
  try {
    realtimeEmails = await loadRealtimeEmails(startDate, endDate);
  } catch (err) {
    mailWarning = err.message || 'Realtime mail map fail';
  }

  const resolveEmail = (code) => {
    if (!code) return '';
    const raw = String(code);
    const lower = raw.toLowerCase();
    const loose = looseLinkId(raw).toLowerCase();
    return (
      realtimeEmails.get(lower) ||
      realtimeEmails.get(loose) ||
      realtimeEmails.get(raw) ||
      ''
    );
  };

  const missing = [];
  for (const row of mappedRows) {
    const code = pathCode(row.path);
    row._code = code;
    const email = resolveEmail(code);
    if (email) {
      row.emails = [email];
      OWNER_CACHE.set(code, [email]);
    } else {
      row.emails = [];
      if (code && isLikelyShortCode(normalizeId(code) || code)) {
        missing.push({ code, views: row.views || 0 });
      }
    }
  }

  // Highest-traffic unmatched only — avoid 2k Firebase HTTP fan-out (504)
  missing.sort((a, b) => b.views - a.views);
  const toLookup = [...new Set(missing.map((m) => m.code))].slice(0, 120);
  if (toLookup.length) {
    try {
      await lookupOwners(toLookup, {
        deadlineMs: 5000,
        concurrency: 30,
        fetchMs: 1800,
      });
    } catch (err) {
      mailWarning = mailWarning || err.message || 'Partial mail lookup';
    }
  }

  for (const row of mappedRows) {
    const code = row._code;
    delete row._code;
    if (row.emails?.length) continue;
    row.emails = code ? OWNER_CACHE.get(code) || [] : [];
  }

  if (rowCount > mappedRows.length) {
    mailWarning =
      (mailWarning ? `${mailWarning} · ` : '') +
      `Top ${mappedRows.length} pages by views (of ${rowCount})`;
  }

  return {
    rows: mappedRows,
    rowCount,
    totals,
    mailWarning,
    complete: !rowCount || mappedRows.length >= rowCount,
  };
}

function pathCode(path) {
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return '';
  return parts[parts.length - 1].trim();
}

function looseLinkId(code) {
  return String(code || '').replace(/--/g, '').replace(/__/g, '');
}

function emailsFromUsers(users) {
  if (!users || typeof users !== 'object') return [];
  const emails = [];
  for (const [key, val] of Object.entries(users)) {
    if (!val) continue;
    const email = String(key).replace(/,/g, '.');
    if (email.includes('@') && !emails.includes(email)) emails.push(email);
  }
  return emails;
}

const OWNER_CACHE = new Map();

async function lookupLooseOwners(codes, options = {}) {
  const unique = [...new Set(codes.map((code) => String(code || '').trim()).filter(Boolean))];
  const deadlineMs = options.deadlineMs || 8000;
  const deadline = Date.now() + deadlineMs;
  const found = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length && Date.now() < deadline) {
      const code = unique[cursor++];
      const cached = OWNER_CACHE.get(code);
      if (cached && cached.length) {
        found.set(code, cached);
        continue;
      }
      const prefix = code.slice(0, 12);
      if (prefix.length < 8) continue;
      try {
        const params = new URLSearchParams({
          orderBy: '"$key"',
          startAt: JSON.stringify(prefix),
          endAt: JSON.stringify(`${prefix}\uf8ff`),
          limitToFirst: '6',
        });
        const res = await fetch(`${FIREBASE_DATABASE_URL}/allLinks.json?${params}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) continue;
        const body = await res.json();
        if (!body || typeof body !== 'object') continue;
        for (const [key, node] of Object.entries(body)) {
          if (key !== code && looseLinkId(key) !== code) continue;
          const fromUsers = emailsFromUsers(node && node.users);
          const owner = node && typeof node.ownerEmail === 'string' && node.ownerEmail.includes('@')
            ? [node.ownerEmail]
            : [];
          const list = fromUsers.length ? fromUsers : owner;
          if (!list.length) continue;
          OWNER_CACHE.set(code, list);
          found.set(code, list);
          break;
        }
      } catch {
        /* try the next code */
      }
    }
  }
  const workers = Math.min(12, unique.length);
  if (workers) {
    await Promise.race([
      Promise.all(Array.from({ length: workers }, () => worker())),
      new Promise((resolve) => setTimeout(resolve, deadlineMs + 500)),
    ]);
  }
  return found;
}

async function lookupOwners(codes, options = {}) {
  const unique = [...new Set(codes.map((code) => String(code || '').trim()).filter(Boolean))];
  const missing = unique.filter((code) => !OWNER_CACHE.has(code));
  const deadlineMs = options.deadlineMs || 5000;
  const fetchMs = options.fetchMs || 2000;
  const deadline = Date.now() + deadlineMs;
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length && Date.now() < deadline) {
      const code = missing[cursor++];
      try {
        const url = `${FIREBASE_DATABASE_URL}/allLinks/${encodeURIComponent(code)}/users.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(fetchMs) });
        if (!res.ok) continue;
        OWNER_CACHE.set(code, emailsFromUsers(await res.json()));
      } catch {
        /* leave uncached so the next batch can retry */
      }
    }
  }
  const workers = Math.min(options.concurrency || 20, missing.length);
  if (workers) {
    await Promise.race([
      Promise.all(Array.from({ length: workers }, () => worker())),
      new Promise((resolve) => setTimeout(resolve, deadlineMs + 400)),
    ]);
  }
  const out = new Map();
  for (const code of unique) out.set(code, OWNER_CACHE.get(code) || []);
  return out;
}

function rollupMails(rows) {
  const map = new Map();
  for (const row of rows) {
    const owners = row.emails?.length ? row.emails : ['Mail not linked'];
    const share = owners.length || 1;
    for (const email of owners) {
      if (!map.has(email)) map.set(email, { email, pages: 0, views: 0, activeUsers: 0, totalRevenue: 0 });
      const item = map.get(email);
      item.pages += 1;
      item.views += (Number(row.views) || 0) / share;
      item.activeUsers += (Number(row.activeUsers) || 0) / share;
      item.totalRevenue += (Number(row.totalRevenue) || 0) / share;
    }
  }
  return [...map.values()];
}

app.get('/api/analytics/pages', async (req, res) => {
  try {
    if (!gaClient) {
      return res.status(500).json({ error: 'GA4 client not initialized' });
    }

    const today = formatDate(new Date());
    const startDate = String(req.query.start_date || today).slice(0, 10);
    const endDate = String(req.query.end_date || startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date cannot be after end_date' });
    }

    const mode = req.query.mode === 'mails' ? 'mails' : req.query.mode === 'series' ? 'series' : 'table';
    const q = String(req.query.q || '').trim().slice(0, 120);
    const limitCap = mode === 'mails' ? 40 : 25;
    const limit = Math.max(1, Math.min(limitCap, parseInt(req.query.limit || String(limitCap), 10) || limitCap));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    const cacheKey = `${mode}|${startDate}|${endDate}|${q}|${limit}|${offset}`;
    const cached = pagesCacheGet(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    if (mode === 'series') {
      const [dateRes] = await Promise.race([
        gaClient.runReport({
          property: `properties/${PROPERTY_ID}`,
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'totalRevenue' }],
          dateRanges: [{ startDate, endDate }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 400,
          dimensionFilter: q
            ? {
                filter: {
                  fieldName: 'unifiedPagePathScreen',
                  stringFilter: { matchType: 'CONTAINS', value: q, caseSensitive: false },
                },
              }
            : undefined,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('GA4 report timed out')), 18000)),
      ]);
      const series = (dateRes.rows || []).map((row) => ({
        date: gaDateToIso(row.dimensionValues?.[0]?.value),
        Total: Number(row.metricValues?.[0]?.value || 0),
        revenue: Number(row.metricValues?.[1]?.value || 0),
      }));
      const body = { startDate, endDate, q, mode, series, seriesPaths: [] };
      pagesCacheSet(cacheKey, body);
      return res.json(body);
    }

    // One server-side pull of all pages + in-memory allLinks map (not 40-row client loop)
    if (mode === 'mails') {
      const pulled = await fetchAllPagesForMails(startDate, endDate, q);
      const mails = rollupMails(pulled.rows).sort(
        (a, b) => (Number(b.views) || 0) - (Number(a.views) || 0),
      );
      const body = {
        startDate,
        endDate,
        q,
        mode,
        limit: pulled.rows.length,
        offset: 0,
        nextOffset: pulled.rows.length,
        done: true,
        rowCount: pulled.rowCount,
        currency: 'INR',
        totals: pulled.totals,
        mails,
        mailWarning: pulled.mailWarning || (pulled.complete ? '' : 'Partial page list (GA4 cap)'),
        complete: pulled.complete,
      };
      pagesCacheSet(cacheKey, body);
      return res.json(body);
    }

    const report = await runPagesReport(startDate, endDate, {
      limit,
      offset,
      q,
      metrics: undefined,
    });
    const metricNames = report._metricNames || PAGE_METRICS;
    const idx = Object.fromEntries(metricNames.map((name, i) => [name, i]));

    const mapRow = (row) => {
      const views = numMetric(row, idx.screenPageViews);
      const activeUsers = numMetric(row, idx.activeUsers);
      const duration = numMetric(row, idx.userEngagementDuration);
      return {
        path: row.dimensionValues?.[0]?.value || '(not set)',
        views,
        activeUsers,
        viewsPerUser: numMetric(row, idx.screenPageViewsPerUser),
        avgEngagementTime: activeUsers ? duration / activeUsers : 0,
        eventCount: numMetric(row, idx.eventCount),
        keyEvents: idx.keyEvents == null ? 0 : numMetric(row, idx.keyEvents),
        totalRevenue: numMetric(row, idx.totalRevenue),
      };
    };

    // Table: sirf is page ke ~25 codes — full allLinks mat lao (Vercel 504/OOM)
    const mappedRows = (report.rows || []).map(mapRow);
    let mailWarning = '';
    try {
      const codes = mappedRows.map((row) => pathCode(row.path)).filter(Boolean);
      await lookupOwners(codes, {
        deadlineMs: 5000,
        concurrency: 20,
        fetchMs: 2000,
      });
    } catch (err) {
      console.error('mail lookup', err);
      mailWarning = err.message || 'Mail map nahi bana';
    }
    for (const row of mappedRows) {
      const code = pathCode(row.path);
      row.emails = code ? OWNER_CACHE.get(code) || [] : [];
    }
    const rows = mappedRows;
    const rowCount = Number(report.rowCount || 0);
    const totalsRow = report.totals?.[0];
    const totals = totalsRow
      ? mapRow({ ...totalsRow, dimensionValues: [{ value: 'Total' }] })
      : {
          path: 'Total',
          views: 0,
          activeUsers: 0,
          viewsPerUser: 0,
          avgEngagementTime: 0,
          eventCount: 0,
          keyEvents: 0,
          totalRevenue: 0,
        };
    totals.path = 'Total';

    const body = {
      startDate,
      endDate,
      q,
      mode,
      limit,
      offset,
      rowCount,
      currency: 'INR',
      totals,
      rows,
      mails: [],
      mailWarning,
      series: [],
      seriesPaths: [],
    };
    pagesCacheSet(cacheKey, body);
    return res.json(body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Pages report failed' });
  }
});

function loadGaCredentials() {
  const gaEnv = process.env.GA4_SERVICE_ACCOUNT
  if (gaEnv) {
    const cred = JSON.parse(gaEnv)
    if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n')
    return cred
  }
  if (fs.existsSync(GA_KEY_FILE)) {
    return JSON.parse(fs.readFileSync(GA_KEY_FILE, 'utf8'))
  }
  return null
}

app.get('/api/admanager/country-cpm', async (req, res) => {
  try {
    const credentials = loadGaCredentials()
    if (!credentials) {
      return res.status(500).json({ error: 'Analytics service account missing' })
    }
    const payload = await getCountryCpm({
      credentials,
      db,
      networkCode: process.env.AD_MANAGER_NETWORK_CODE || '23113214187',
      force: req.query.refresh === '1',
    })
    return res.json(payload)
  } catch (e) {
    console.error(e)
    return res.status(502).json({ error: e.message || 'Ad Manager CPM failed' })
  }
})

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
