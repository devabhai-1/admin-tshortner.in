"""
GA4 analytics API for TShortner Admin frontend.
Place credentials next to this file:
  - service_account.json      (Google Analytics Data API)
  - service_account_key.json   (Firebase Admin SDK)
"""
import os
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

# Windows: Python often ships without CA roots → Google APIs SSL fails
try:
    import certifi
    import ssl

    _CA_BUNDLE = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", _CA_BUNDLE)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _CA_BUNDLE)
    os.environ.setdefault("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", _CA_BUNDLE)

    def _https_context_with_certifi():
        return ssl.create_default_context(cafile=_CA_BUNDLE)

    ssl._create_default_https_context = _https_context_with_certifi

    import requests

    _session_request = requests.Session.request

    def _session_request_with_certifi(self, method, url, **kwargs):
        kwargs.setdefault("verify", _CA_BUNDLE)
        return _session_request(self, method, url, **kwargs)

    requests.Session.request = _session_request_with_certifi
except ImportError:
    _CA_BUNDLE = None

import json
from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import RunReportRequest, DateRange, Dimension, Metric
from google.oauth2 import service_account
import firebase_admin
from firebase_admin import credentials, db
from google.api_core import exceptions as google_exceptions

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

PROPERTY_ID = os.environ.get("GA4_PROPERTY_ID", "469135333")
# Default rolling window when client sends days=N (initial fast load)
GA4_DEFAULT_DAYS = int(os.environ.get("GA4_DEFAULT_DAYS", "5"))
# When days=all (or default 0): how far back to query (GA4 property retention)
GA4_LOOKBACK_DAYS = int(os.environ.get("GA4_LOOKBACK_DAYS", "1825"))
# GA4 Data API max per HTTP request; we paginate until row_count is fully satisfied (no total row cap).
GA4_PAGE_SIZE = int(os.environ.get("GA4_PAGE_SIZE", "50000"))
# Optional hard cap on date span (0 = disabled / unlimited)
GA4_MAX_RANGE_DAYS = int(os.environ.get("GA4_MAX_RANGE_DAYS", "0"))
GA4_TIMEOUT_SEC = float(os.environ.get("GA4_TIMEOUT_SEC", "45"))
GA4_RETRIES = int(os.environ.get("GA4_RETRIES", "4"))
GA4_RETRY_BASE_SLEEP_SEC = float(os.environ.get("GA4_RETRY_BASE_SLEEP_SEC", "1.2"))

# Small in-memory cache so latest 5 days loads instantly
_GA_RANGE_CACHE = {"ttl": 45.0, "data": {}}
GA_KEY_FILE = os.path.join(BASE_DIR, "service_account.json")
FB_KEY_FILE = os.path.join(BASE_DIR, "service_account_key.json")
FIREBASE_DATABASE_URL = os.environ.get(
    "FIREBASE_DATABASE_URL",
    "https://tshortner-in-default-rtdb.asia-southeast1.firebasedatabase.app",
)

app = Flask(__name__)
CORS(app)

# ---------------- FIREBASE ----------------
try:
    if not firebase_admin._apps:
        cred = credentials.Certificate(FB_KEY_FILE)
        firebase_admin.initialize_app(
            cred,
            {
                "databaseURL": FIREBASE_DATABASE_URL,
            },
        )
    print("✅ Firebase connected")
except Exception as e:
    print("❌ Firebase failed:", e)
    traceback.print_exc()

# ---------------- GA4 CLIENT ----------------
try:
    GA_CREDENTIALS = service_account.Credentials.from_service_account_file(GA_KEY_FILE)
    # REST avoids gRPC SSL issues on Windows (CERTIFICATE_VERIFY_FAILED)
    ga_client = BetaAnalyticsDataClient(credentials=GA_CREDENTIALS, transport="rest")
    print("✅ GA4 client initialized (REST)")
except Exception as e:
    print("❌ GA4 client init failed:", e)
    ga_client = None
    traceback.print_exc()


# ---------------- HELPERS ----------------
def normalize_id(val):
    if not val:
        return None
    val = val.strip().lower()
    val = re.sub(r"^/+", "", val)
    val = re.sub(r"/+$", "", val)
    val = val.replace("pages/", "").replace("al/", "")
    val = val.split("?")[0]
    return val


def extract_link_id(path):
    if not path:
        return None
    path = path.strip().lower()
    path = re.sub(r"^/+", "", path)
    path = re.sub(r"/+$", "", path)
    path = path.split("?")[0]
    path = path.replace("pages/", "").replace("al/", "")
    return path.split("/")[-1]


def parse_iso_date(s):
    """Parse YYYY-MM-DD; return None if invalid."""
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    try:
        y, m, d = s.split("-")
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def decode_email_key(key):
    """Site uses comma in RTDB keys; legacy admin used underscore."""
    if not key:
        return ""
    if "," in key:
        return key.replace(",", ".")
    return key.replace("_", ".")


def _collect_link_codes_from_user(user):
    """Link codes from tshortner site: links/telegram|website/list + legacy shortner.telegram."""
    codes = set()
    links = user.get("links") or {}
    for channel in ("telegram", "website"):
        lst = (links.get(channel) or {}).get("list") or {}
        if isinstance(lst, dict):
            for _item_id, item in lst.items():
                if isinstance(item, dict):
                    code = normalize_id(item.get("code"))
                    if code:
                        codes.add(code)
    legacy = (user.get("shortner") or {}).get("telegram") or {}
    if isinstance(legacy, dict):
        for link_id in legacy.keys():
            lid = normalize_id(link_id)
            if lid:
                codes.add(lid)
    return codes


def firebase_mapping():
    """Return dict: email → [ {id, raw}, ... ] for GA4 pagePath → /s/<code> matching."""
    try:
        ref_users = db.reference("users").get() or {}
        all_links = db.reference("allLinks").get() or {}
        mapping = {}

        for email_key, user in ref_users.items():
            if not isinstance(user, dict):
                continue
            email = decode_email_key(email_key)
            codes = _collect_link_codes_from_user(user)

            # Global allLinks: { code: { users: { emailKey: true } } }
            for code, meta in (all_links or {}).items():
                if not isinstance(meta, dict):
                    continue
                users_on = meta.get("users") or {}
                if email_key in users_on:
                    lid = normalize_id(code)
                    if lid:
                        codes.add(lid)

            if not codes:
                continue
            mapping[email] = [{"id": c, "raw": c} for c in sorted(codes)]

        return mapping

    except Exception:
        traceback.print_exc()
        return {}


_FB_MAP_CACHE = {"at": 0.0, "data": None}
_FB_MAP_TTL_SEC = float(os.environ.get("FIREBASE_MAP_CACHE_SEC", "120"))


def firebase_mapping_cached(force_refresh: bool = False):
    """In-memory TTL cache — हर GA4 hit पर पूरा RTDB users न खींचें।"""
    now = time.monotonic()
    if (
        not force_refresh
        and _FB_MAP_CACHE["data"] is not None
        and (now - _FB_MAP_CACHE["at"]) < _FB_MAP_TTL_SEC
    ):
        return _FB_MAP_CACHE["data"]
    data = firebase_mapping()
    _FB_MAP_CACHE["at"] = now
    _FB_MAP_CACHE["data"] = data
    return data


def link_id_to_email_lookup(fb_map):
    """GA4 हर row के लिए O(1) मैच — पहले वाला email जीतता है (डुप्लिकेट id पर)।"""
    out = {}
    for email, ids in fb_map.items():
        for ent in ids:
            lid = ent.get("id")
            if lid and lid not in out:
                out[lid] = email
    return out


def _ga4_page_size():
    """Per-request page size (Google hard max 250k); not a total row limit."""
    return max(1, min(GA4_PAGE_SIZE, 250000))

def _ga4_sleep_for_retry(attempt: int):
    # attempt: 0..N-1
    delay = GA4_RETRY_BASE_SLEEP_SEC * (2 ** attempt)
    # cap to 12s
    time.sleep(min(delay, 12.0))

def _is_transient_ga_error(exc: Exception) -> bool:
    msg = str(exc or "")
    return (
        "UNEXPECTED_EOF_WHILE_READING" in msg
        or "Read timed out" in msg
        or "SSLEOFError" in msg
        or "EOF occurred in violation of protocol" in msg
        or "Connection reset by peer" in msg
        or isinstance(exc, google_exceptions.ServiceUnavailable)
        or isinstance(exc, google_exceptions.DeadlineExceeded)
    )

def run_ga4_report(start_date, end_date):
    """Fetch every GA4 row — paginate until API row_count is fully retrieved.

    On flaky networks (Windows SSL EOF / read timeout), returns partial rows with complete=False.
    """
    all_rows = []
    page_size = _ga4_page_size()
    total_expected = None
    pages = 0
    complete = True
    last_error = None

    while True:
        offset = len(all_rows)
        req = RunReportRequest(
            property=f"properties/{PROPERTY_ID}",
            dimensions=[Dimension(name="date"), Dimension(name="pagePath")],
            metrics=[Metric(name="screenPageViews")],
            date_ranges=[DateRange(start_date=str(start_date), end_date=str(end_date))],
            limit=page_size,
            offset=offset,
        )
        res = None
        for attempt in range(GA4_RETRIES):
            try:
                res = ga_client.run_report(req, timeout=GA4_TIMEOUT_SEC)
                last_error = None
                break
            except Exception as e:
                last_error = e
                if _is_transient_ga_error(e) and attempt < (GA4_RETRIES - 1):
                    _ga4_sleep_for_retry(attempt)
                    continue
                raise

        if res is None:
            complete = False
            break
        pages += 1
        if total_expected is None:
            total_expected = int(res.row_count or 0)

        batch = list(res.rows)
        if not batch:
            break

        all_rows.extend(batch)

        if total_expected and len(all_rows) >= total_expected:
            break
        if len(batch) < page_size:
            break

    if last_error is not None:
        complete = False
    return all_rows, total_expected or len(all_rows), pages, complete, (str(last_error) if last_error else "")


def _rows_to_output(ga_rows, lid_lookup, raw_mode: bool):
    out = []
    for r in ga_rows:
        raw_date = r.dimension_values[0].value
        page_path = r.dimension_values[1].value
        views = int(r.metric_values[0].value)

        readable_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        link_id = normalize_id(extract_link_id(page_path))

        if raw_mode:
            matched_email = lid_lookup.get(link_id) if link_id else None
            if not link_id and not page_path:
                continue
            out.append(
                {
                    "date": readable_date,
                    "email": matched_email or "",
                    "pagePath": page_path or "",
                    "linkId": link_id or "",
                    "views": views,
                }
            )
            continue

        # Firebase allocation mode: still emit rows even if mapping fails,
        # so UI can show live progress and linkIds without looking "blank".
        if not link_id:
            continue
        matched_email = lid_lookup.get(link_id)
        out.append(
            {
                "date": readable_date,
                "email": matched_email or "",
                "linkId": link_id or "",
                "pagePath": page_path or "",
                "views": views,
                "matched": bool(matched_email),
            }
        )
    return out


@app.route("/api/analytics/stream")
def get_analytics_stream():
    """SSE stream: emits progress + incremental rows while GA4 is fetching."""
    try:
        if ga_client is None:
            return jsonify({"error": "GA4 client not initialized"}), 500

        force_fb = request.args.get("refresh_map") == "1"
        raw_mode = request.args.get("mode") == "raw"

        # Parse date range exactly like /api/analytics
        today = date.today()
        end_date = today
        unlimited_days = False

        days_qs = (request.args.get("days") or "").strip().lower()
        if days_qs in ("all", "0", "unlimited", "-1") or (
            not days_qs and GA4_DEFAULT_DAYS <= 0
        ):
            unlimited_days = True
            start_date = today - timedelta(days=max(GA4_LOOKBACK_DAYS - 1, 0))
        elif days_qs and not request.args.get("start_date"):
            try:
                n_days = max(1, int(days_qs))
                start_date = today - timedelta(days=n_days - 1)
            except ValueError:
                start_date = today - timedelta(days=max(GA4_DEFAULT_DAYS - 1, 0))
        else:
            start_date = today - timedelta(
                days=max(GA4_DEFAULT_DAYS - 1, 0)
                if GA4_DEFAULT_DAYS > 0
                else GA4_LOOKBACK_DAYS - 1
            )
            if GA4_DEFAULT_DAYS <= 0:
                unlimited_days = True

        qs_start = request.args.get("start_date")
        qs_end = request.args.get("end_date")
        if qs_start and qs_end:
            p_start = parse_iso_date(qs_start)
            p_end = parse_iso_date(qs_end)
            if p_start and p_end:
                start_date = min(p_start, p_end)
                end_date = max(p_start, p_end)
                unlimited_days = False
            else:
                return jsonify({"error": "Invalid start_date or end_date (use YYYY-MM-DD)"}), 400

        if end_date > today:
            end_date = today
        if start_date > today:
            start_date = today

        if GA4_MAX_RANGE_DAYS > 0 and (end_date - start_date).days > GA4_MAX_RANGE_DAYS:
            return (
                jsonify(
                    {
                        "error": f"Date range too large (max {GA4_MAX_RANGE_DAYS} days)",
                        "start_date": str(start_date),
                        "end_date": str(end_date),
                    }
                ),
                400,
            )

        fb_map = firebase_mapping_cached(force_fb)
        lid_lookup = link_id_to_email_lookup(fb_map)

        start_s = str(start_date)
        end_s = str(end_date)
        page_size = _ga4_page_size()

        @stream_with_context
        def gen():
            def emit(event, payload):
                return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

            yield emit(
                "start",
                {
                    "start_date": start_s,
                    "end_date": end_s,
                    "unlimited_days": unlimited_days,
                    "raw_mode": raw_mode,
                    "page_size": page_size,
                },
            )

            all_ga_rows = []
            output_rows = []
            total_expected = None
            pages = 0
            last_error = ""

            while True:
                offset = len(all_ga_rows)
                req = RunReportRequest(
                    property=f"properties/{PROPERTY_ID}",
                    dimensions=[Dimension(name="date"), Dimension(name="pagePath")],
                    metrics=[Metric(name="screenPageViews")],
                    date_ranges=[DateRange(start_date=start_s, end_date=end_s)],
                    limit=page_size,
                    offset=offset,
                )

                res = None
                for attempt in range(GA4_RETRIES):
                    try:
                        res = ga_client.run_report(req, timeout=GA4_TIMEOUT_SEC)
                        last_error = ""
                        break
                    except Exception as e:
                        last_error = str(e)
                        if _is_transient_ga_error(e) and attempt < (GA4_RETRIES - 1):
                            _ga4_sleep_for_retry(attempt)
                            continue
                        yield emit("error", {"message": last_error})
                        yield emit(
                            "done",
                            {
                                "rows": output_rows,
                                "meta": {
                                    "start_date": start_s,
                                    "end_date": end_s,
                                    "unlimited_days": unlimited_days,
                                    "ga4_rows_expected": total_expected or len(all_ga_rows),
                                    "ga4_rows_fetched": len(all_ga_rows),
                                    "ga4_pages": pages,
                                    "ga4_complete": False,
                                    "ga4_error": last_error,
                                    "output_rows": len(output_rows),
                                    "raw_mode": raw_mode,
                                },
                            },
                        )
                        return

                if res is None:
                    yield emit("error", {"message": last_error or "Unknown GA4 error"})
                    break

                pages += 1
                if total_expected is None:
                    total_expected = int(res.row_count or 0)

                batch = list(res.rows)
                if not batch:
                    break

                all_ga_rows.extend(batch)
                out_batch = _rows_to_output(batch, lid_lookup, raw_mode)
                if out_batch:
                    output_rows.extend(out_batch)
                    # stream only the converted rows (smaller)
                    yield emit(
                        "rows",
                        {
                            "rows": out_batch,
                            "meta": {
                                "ga4_rows_expected": total_expected,
                                "ga4_rows_fetched": len(all_ga_rows),
                                "ga4_pages": pages,
                                "output_rows": len(output_rows),
                            },
                        },
                    )

                yield emit(
                    "progress",
                    {
                        "ga4_rows_expected": total_expected,
                        "ga4_rows_fetched": len(all_ga_rows),
                        "ga4_pages": pages,
                        "output_rows": len(output_rows),
                    },
                )

                if total_expected and len(all_ga_rows) >= total_expected:
                    break
                if len(batch) < page_size:
                    break

            ga_complete = (total_expected is None) or (len(all_ga_rows) >= total_expected)
            yield emit(
                "done",
                {
                    "rows": output_rows,
                    "meta": {
                        "start_date": start_s,
                        "end_date": end_s,
                        "unlimited_days": unlimited_days,
                        "ga4_rows_expected": total_expected or len(all_ga_rows),
                        "ga4_rows_fetched": len(all_ga_rows),
                        "ga4_pages": pages,
                        "ga4_complete": ga_complete,
                        "ga4_error": last_error,
                        "output_rows": len(output_rows),
                        "raw_mode": raw_mode,
                    },
                },
            )

        return Response(gen(), mimetype="text/event-stream")

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ---------------- GA4 API ROUTE ----------------
@app.route("/api/analytics")
def get_analytics():
    try:
        if ga_client is None:
            return jsonify({"error": "GA4 client not initialized"}), 500

        force_fb = request.args.get("refresh_map") == "1"
        raw_mode = request.args.get("mode") == "raw"
        today = date.today()
        end_date = today
        unlimited_days = False

        days_qs = (request.args.get("days") or "").strip().lower()
        if days_qs in ("all", "0", "unlimited", "-1") or (
            not days_qs and GA4_DEFAULT_DAYS <= 0
        ):
            unlimited_days = True
            start_date = today - timedelta(days=max(GA4_LOOKBACK_DAYS - 1, 0))
        elif days_qs and not request.args.get("start_date"):
            try:
                n_days = max(1, int(days_qs))
                start_date = today - timedelta(days=n_days - 1)
            except ValueError:
                start_date = today - timedelta(days=max(GA4_DEFAULT_DAYS - 1, 0))
        else:
            start_date = today - timedelta(
                days=max(GA4_DEFAULT_DAYS - 1, 0) if GA4_DEFAULT_DAYS > 0 else GA4_LOOKBACK_DAYS - 1
            )
            if GA4_DEFAULT_DAYS <= 0:
                unlimited_days = True

        qs_start = request.args.get("start_date")
        qs_end = request.args.get("end_date")
        if qs_start and qs_end:
            p_start = parse_iso_date(qs_start)
            p_end = parse_iso_date(qs_end)
            if p_start and p_end:
                start_date = min(p_start, p_end)
                end_date = max(p_start, p_end)
                unlimited_days = False
            else:
                return jsonify({"error": "Invalid start_date or end_date (use YYYY-MM-DD)"}), 400

        if end_date > today:
            end_date = today
        if start_date > today:
            start_date = today

        if GA4_MAX_RANGE_DAYS > 0 and (end_date - start_date).days > GA4_MAX_RANGE_DAYS:
            return (
                jsonify(
                    {
                        "error": f"Date range too large (max {GA4_MAX_RANGE_DAYS} days)",
                        "start_date": str(start_date),
                        "end_date": str(end_date),
                    }
                ),
                400,
            )

        cache_key = (str(start_date), str(end_date), bool(raw_mode))
        cached = _GA_RANGE_CACHE["data"].get(cache_key)
        now = time.monotonic()
        if cached and (now - cached["at"]) < _GA_RANGE_CACHE["ttl"]:
            ga_rows = cached["rows"]
            ga_row_count = cached["row_count"]
            ga_pages = cached["pages"]
            ga_complete = cached.get("complete", True)
            ga_error = cached.get("error", "")
        else:
            ga_rows = ga_row_count = ga_pages = None
            ga_complete = True
            ga_error = ""

        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_map = pool.submit(firebase_mapping_cached, force_fb)
            fb_map = fut_map.result()
            if ga_rows is None:
                fut_ga = pool.submit(run_ga4_report, start_date, end_date)
                ga_rows, ga_row_count, ga_pages, ga_complete, ga_error = fut_ga.result()
                _GA_RANGE_CACHE["data"][cache_key] = {
                    "at": now,
                    "rows": ga_rows,
                    "row_count": ga_row_count,
                    "pages": ga_pages,
                    "complete": ga_complete,
                    "error": ga_error,
                }
        lid_lookup = link_id_to_email_lookup(fb_map)
        ga_complete = bool(ga_complete) and (len(ga_rows) >= ga_row_count)

        output = []

        for r in ga_rows:
            raw_date = r.dimension_values[0].value
            page_path = r.dimension_values[1].value
            views = int(r.metric_values[0].value)

            readable_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
            link_id = normalize_id(extract_link_id(page_path))

            if raw_mode:
                matched_email = lid_lookup.get(link_id) if link_id else None
                if not link_id and not page_path:
                    continue
                output.append(
                    {
                        "date": readable_date,
                        "email": matched_email or "",
                        "pagePath": page_path or "",
                        "linkId": link_id or "",
                        "views": views,
                    }
                )
                continue

            if not link_id:
                continue
            matched_email = lid_lookup.get(link_id)
            if matched_email:
                output.append({"date": readable_date, "email": matched_email, "views": views})

        return jsonify(
            {
                "rows": output,
                "meta": {
                    "start_date": str(start_date),
                    "end_date": str(end_date),
                    "unlimited_days": unlimited_days,
                    "ga4_rows_expected": ga_row_count,
                    "ga4_rows_fetched": len(ga_rows),
                    "ga4_pages": ga_pages,
                    "ga4_complete": ga_complete,
                    "ga4_error": ga_error,
                    "output_rows": len(output),
                    "raw_mode": raw_mode,
                },
            }
        )

    except Exception as e:
        msg = str(e)
        if isinstance(e, google_exceptions.ServiceUnavailable) or "CERTIFICATE_VERIFY_FAILED" in msg:
            traceback.print_exc()
            return (
                jsonify(
                    {
                        "error": "GA4 connection failed (SSL/network). On Windows run: pip install certifi",
                        "detail": msg,
                        "hint": "Restart backend after installing certifi. Check firewall/VPN if it persists.",
                    }
                ),
                503,
            )
        if "PermissionDenied" in msg or "PERMISSION_DENIED" in msg or "403" in msg:
            traceback.print_exc()
            return (
                jsonify(
                    {
                        "error": "GA4 permission denied",
                        "property": f"properties/{PROPERTY_ID}",
                        "hint": "Grant this app's service account access to the GA4 property (Viewer/Analyst+) and verify PROPERTY_ID.",
                    }
                ),
                403,
            )

        traceback.print_exc()
        return jsonify({"error": msg}), 500


@app.route("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "ga4": ga_client is not None,
            "firebase": bool(firebase_admin._apps),
            "property_id": PROPERTY_ID,
        }
    )


@app.route("/")
def root():
    return jsonify({"service": "tshortner-admin-backend", "docs": "/api/health"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"Listening http://{host}:{port} (cwd keys: {BASE_DIR})")
    debug = os.environ.get("FLASK_DEBUG", "1").lower() in ("1", "true", "yes")
    app.run(host=host, port=port, debug=debug)
