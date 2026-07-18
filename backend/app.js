import express from 'express';
import cors from 'cors';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

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
    cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  }
  
  if (cred.private_key) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }

  const app_firebase = initializeApp({
    credential: cert(cred),
    databaseURL: FIREBASE_DATABASE_URL
  });
  db = getDatabase(app_firebase);
  console.log("✅ Firebase connected");
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
  } else {
    gaClient = new BetaAnalyticsDataClient({
      keyFilename: path.join(__dirname, 'service_account.json')
    });
  }
  console.log("✅ GA4 client initialized");
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

async function firebaseMapping() {
  try {
    const refUsersSnap = await db.ref("users").once('value');
    const refUsers = refUsersSnap.val() || {};
    const allLinksSnap = await db.ref("allLinks").once('value');
    const allLinks = allLinksSnap.val() || {};
    const mapping = {};

    for (const emailKey in refUsers) {
      const user = refUsers[emailKey];
      if (typeof user !== 'object') continue;
      const email = decodeEmailKey(emailKey);
      const codes = collectLinkCodesFromUser(user);

      for (const code in allLinks) {
        const meta = allLinks[code];
        if (typeof meta !== 'object') continue;
        const usersOn = meta.users || {};
        if (usersOn[emailKey]) {
          const lid = normalizeId(code);
          if (lid) codes.add(lid);
        }
      }

      if (codes.size === 0) continue;
      mapping[email] = Array.from(codes).sort().map(c => ({ id: c, raw: c }));
    }
    return mapping;
  } catch (e) {
    console.error(e);
    return {};
  }
}

const FB_MAP_CACHE = { at: 0, data: null };
const FB_MAP_TTL_SEC = parseFloat(process.env.FIREBASE_MAP_CACHE_SEC || '120');

async function firebaseMappingCached(forceRefresh = false) {
  const now = Date.now() / 1000;
  if (!forceRefresh && FB_MAP_CACHE.data && (now - FB_MAP_CACHE.at) < FB_MAP_TTL_SEC) {
    return FB_MAP_CACHE.data;
  }
  const data = await firebaseMapping();
  FB_MAP_CACHE.at = now;
  FB_MAP_CACHE.data = data;
  return data;
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

// --- Routes ---
app.post('/api/login', express.json(), async (req, res) => {
    const { username, password } = req.body;
    
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (Array.isArray(ip)) ip = ip[0];
    ip = ip.split(',')[0].trim();
    const safeIp = ip.replace(/[.#$[\]\s]/g, '_');
    
    const today = formatDate(new Date());
    let failedCount = 0;
    
    try {
        if (db) {
            const snap = await db.ref(`security/failed_logins/${today}/${safeIp}`).once('value');
            failedCount = snap.val() || 0;
        }
    } catch (e) {
        console.error("Firebase read error on login check", e);
    }
    
    if (failedCount >= 10) {
        return res.status(429).json({ 
            success: false, 
            error: 'Maximum attempts reached! Login is locked for today.' 
        });
    }

    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        try {
            if (db) await db.ref(`security/failed_logins/${today}/${safeIp}`).remove();
        } catch (e) {}
        return res.json({ success: true, token: 'admin-authorized-token' });
    } else {
        try {
            if (db) await db.ref(`security/failed_logins/${today}/${safeIp}`).set(failedCount + 1);
        } catch (e) {}
        
        const remaining = 10 - (failedCount + 1);
        return res.status(401).json({ 
            success: false, 
            error: remaining > 0 ? `Invalid credentials. ${remaining} attempts remaining.` : 'Maximum attempts reached! Login is locked for today.'
        });
    }
});

app.get('/api/analytics', async (req, res) => {
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

        const emit = (event, payload) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        emit("start", {
            start_date: startS,
            end_date: endS,
            unlimited_days: unlimitedDays,
            raw_mode: rawMode,
            page_size: Math.max(1, Math.min(GA4_PAGE_SIZE, 250000))
        });

        const fbMap = await firebaseMappingCached(forceFb);
        const lidLookup = linkIdToEmailLookup(fbMap);

        const allGaRows = [];
        const outputRows = [];
        let totalExpected = null;
        let pages = 0;
        let lastError = "";
        let offset = 0;
        const pageSize = Math.max(1, Math.min(GA4_PAGE_SIZE, 250000));

        while (true) {
            try {
                const [response] = await gaClient.runReport({
                    property: `properties/${PROPERTY_ID}`,
                    dimensions: [{ name: 'date' }, { name: 'pagePath' }],
                    metrics: [{ name: 'screenPageViews' }],
                    dateRanges: [{ startDate: startS, endDate: endS }],
                    limit: pageSize,
                    offset: offset,
                });

                pages++;
                if (totalExpected === null) {
                    totalExpected = response.rowCount ? parseInt(response.rowCount, 10) : 0;
                }

                const batch = response.rows || [];
                if (batch.length === 0) break;

                allGaRows.push(...batch);
                offset += batch.length;

                const outBatch = rowsToOutput(batch, lidLookup, rawMode);
                if (outBatch.length > 0) {
                    outputRows.push(...outBatch);
                    emit("rows", {
                        rows: outBatch,
                        meta: {
                            ga4_rows_expected: totalExpected,
                            ga4_rows_fetched: allGaRows.length,
                            ga4_pages: pages,
                            output_rows: outputRows.length
                        }
                    });
                }

                emit("progress", {
                    ga4_rows_expected: totalExpected,
                    ga4_rows_fetched: allGaRows.length,
                    ga4_pages: pages,
                    output_rows: outputRows.length
                });

                if (totalExpected && allGaRows.length >= totalExpected) break;
                if (batch.length < pageSize) break;

            } catch (e) {
                lastError = e.message;
                emit("error", { message: lastError });
                break;
            }
        }

        const gaComplete = (totalExpected === null) || (allGaRows.length >= totalExpected);
        emit("done", {
            rows: outputRows,
            meta: {
                start_date: startS,
                end_date: endS,
                unlimited_days: unlimitedDays,
                ga4_rows_expected: totalExpected || allGaRows.length,
                ga4_rows_fetched: allGaRows.length,
                ga4_pages: pages,
                ga4_complete: gaComplete,
                ga4_error: lastError,
                output_rows: outputRows.length,
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
        firebase: !!admin.apps.length,
        property_id: PROPERTY_ID
    });
});

app.get('/', (req, res) => {
    res.json({ service: "tshortner-admin-backend-node", docs: "/api/health" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Listening http://localhost:${PORT} (cwd keys: ${__dirname})`);
});

export default app;
