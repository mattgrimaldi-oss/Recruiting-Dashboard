#!/usr/bin/env python3
"""
Greenhouse Recruiting Pipeline Exporter (v3 API)
=================================================
Pulls candidate pipeline data from Greenhouse's Harvest v3 API
and outputs weekly funnel stats + stage timing for the dashboard.

Setup:
  1. pip3 install requests
  2. Replace the V3_KEY and V3_SECRET below with your credentials
  3. Run: python3 greenhouse_v3.py

Commands:
  python3 greenhouse_v3.py              # Weekly funnel data (per job)
  python3 greenhouse_v3.py --stages     # Show all stages + active candidates
  python3 greenhouse_v3.py --timing     # Avg days between each stage
  python3 greenhouse_v3.py --output greenhouse_funnel.json  # Save to file
"""

import requests
import json
import sys
import os
from base64 import b64encode
from datetime import datetime, timedelta
from collections import defaultdict, Counter

# ============================================================
# CONFIGURATION — Replace with your Greenhouse v3 credentials
# ============================================================
V3_KEY = os.environ.get("GREENHOUSE_V3_KEY", "YOUR_KEY_HERE")
V3_SECRET = os.environ.get("GREENHOUSE_V3_SECRET", "YOUR_SECRET_HERE")

# v1 key — used for funnel and stages commands (proven to work)
V1_API_KEY = os.environ.get("GREENHOUSE_API_KEY", "YOUR_V1_KEY_HERE")

# How many weeks of history to pull. 24 so the dashboard's default
# "Since Matt & Connor" view (cutoff 2026-02-02) is fully covered.
WEEKS_BACK = 24

# ============================================================
# STAGE MAPPING — Your actual Greenhouse stage names
# ============================================================
STAGE_MAPPING = {
    "application_review": [
        "application review", "app review", "review",
    ],
    "screens": [
        "phone interview", "phone screen", "recruiter screen",
        "recruiter phone screen", "hiring manager screen",
        "hm screen", "initial screen", "intro call", "screening", "screen",
    ],
    "takehomes": [
        "take home test", "take home", "take-home", "takehome",
        "homework", "technical assessment", "code challenge",
        "coding challenge", "work sample", "assessment",
    ],
    "virtuals": [
        "virtual", "virtual interview", "video interview",
        "zoom interview", "virtual onsite",
    ],
    "face_to_face": [
        "face to face", "face-to-face", "onsite", "on-site",
        "in-person", "in person", "final round", "panel",
    ],
    "background_check": [
        "checkr", "background check", "background",
    ],
    "offers": [
        "offer",
    ],
}


# ============================================================
# AUTH — Get a Bearer token from v3 OAuth
# ============================================================
def get_v3_token():
    """Exchange v3 key+secret for a bearer token."""
    cred = b64encode(f"{V3_KEY}:{V3_SECRET}".encode()).decode()
    resp = requests.post(
        "https://auth.greenhouse.io/token",
        headers={
            "Authorization": f"Basic {cred}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data="grant_type=client_credentials",
    )
    if resp.status_code != 200:
        print(f"ERROR: Failed to get v3 token: {resp.status_code}")
        print(resp.text)
        sys.exit(1)
    token = resp.json().get("access_token")
    if not token:
        print("ERROR: No access_token in response")
        print(resp.json())
        sys.exit(1)
    return token


# ============================================================
# V3 API HELPERS
# ============================================================
V3_BASE = "https://harvest.greenhouse.io/v3"


def v3_get(token, endpoint, params=None):
    """Make a paginated GET request to the v3 API."""
    all_results = []
    url = f"{V3_BASE}/{endpoint}"
    headers = {"Authorization": f"Bearer {token}"}
    per_page = 500
    is_first = True

    while url:
        if is_first:
            # First request: include params
            p = {"per_page": per_page}
            if params:
                p.update(params)
            resp = requests.get(url, headers=headers, params=p)
            is_first = False
        else:
            # Subsequent requests: cursor URL already has params baked in
            resp = requests.get(url, headers=headers)

        if resp.status_code != 200:
            print(f"  ERROR: {endpoint} returned {resp.status_code}")
            print(f"  {resp.text[:300]}")
            break
        data = resp.json()
        if isinstance(data, list):
            all_results.extend(data)
        elif isinstance(data, dict) and "results" in data:
            all_results.extend(data["results"])
        else:
            all_results.append(data)

        # v3 cursor pagination via Link header
        url = None
        link = resp.headers.get("Link", "")
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part.split(";")[0].strip().strip("<>")
                    break

        if len(all_results) >= 10000:
            print(f"  (capped at 10,000 for /{endpoint})")
            break

    return all_results


# ============================================================
# V1 API HELPERS (fallback for non-v3 features)
# ============================================================
V1_BASE = "https://harvest.greenhouse.io/v1"


def v1_get_auth():
    token = b64encode(f"{V1_API_KEY}:".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def v1_get(endpoint, params=None):
    all_results = []
    page = 1
    while True:
        p = {"per_page": 100, "page": page}
        if params:
            p.update(params)
        resp = requests.get(f"{V1_BASE}/{endpoint}", headers=v1_get_auth(), params=p)
        if resp.status_code != 200:
            break
        data = resp.json()
        if not data:
            break
        all_results.extend(data)
        if len(data) < 100:
            break
        page += 1
        if len(all_results) >= 10000:
            break
    return all_results


# ============================================================
# STAGE CLASSIFICATION
# ============================================================
def classify_stage(stage_name):
    name_lower = stage_name.lower().strip()
    for bucket, keywords in STAGE_MAPPING.items():
        for keyword in keywords:
            if name_lower == keyword:
                return bucket
    for bucket, keywords in STAGE_MAPPING.items():
        for keyword in keywords:
            if keyword in name_lower:
                return bucket
    return None


def get_monday(dt):
    monday = dt - timedelta(days=dt.weekday())
    return monday.strftime("%Y-%m-%d")


# ============================================================
# COMMAND: --timing  (pipeline speed using v1 application data)
# ============================================================
def cmd_timing(token):
    """Median pipeline time using applied_at, rejected_at, and current_stage from v1 API.
    Includes ALL candidates — active, rejected, and hired."""
    if not V1_API_KEY:
        print("ERROR: The timing command needs your v1 API key.")
        print('Add: V1_API_KEY = "your_v1_key_here"')
        sys.exit(1)

    cutoff = datetime.now() - timedelta(weeks=WEEKS_BACK)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00Z")
    now = datetime.now()

    print(f"Pulling ALL applications from last {WEEKS_BACK} weeks...\n")

    # Pull all applications (active + rejected + hired)
    all_apps = v1_get("applications", {"created_after": cutoff_str})
    print(f"  Found {len(all_apps)} total applications")

    # Pull jobs for names
    jobs = v1_get("jobs", {"status": "open"})
    job_names = {j["id"]: j["name"] for j in jobs if "id" in j}

    # Build stage name lookup
    stage_names = {}
    for job in jobs:
        if "id" in job:
            try:
                stages = v1_get(f"jobs/{job['id']}/stages")
                for s in stages:
                    stage_names[s["id"]] = s["name"]
            except:
                pass

    # Pipeline stages
    PIPELINE = [
        "Application Review", "Phone Interview", "Take Home Test",
        "Virtual", "Face to Face", "Checkr", "Offer",
    ]
    pipeline_order = {name: i for i, name in enumerate(PIPELINE)}

    def med(vals):
        if not vals:
            return 0
        s = sorted(vals)
        n = len(s)
        if n % 2 == 0:
            return (s[n // 2 - 1] + s[n // 2]) / 2
        return s[n // 2]

    # Metrics
    rejected_at_stage = defaultdict(list)
    active_at_stage = defaultdict(list)
    hired_total_time = []
    stage_counts = defaultdict(lambda: {"active": 0, "rejected": 0, "hired": 0})

    for app in all_apps:
        applied = app.get("applied_at") or app.get("created_at")
        if not applied:
            continue

        try:
            applied_dt = datetime.fromisoformat(applied.replace("Z", "+00:00")).replace(tzinfo=None)
        except:
            continue

        status = app.get("status", "active")

        # Handle HIRED candidates first (current_stage may be null)
        if status == "hired":
            last = app.get("last_activity_at")
            if last:
                try:
                    hire_dt = datetime.fromisoformat(last.replace("Z", "+00:00")).replace(tzinfo=None)
                    days = (hire_dt - applied_dt).total_seconds() / 86400
                    if 0 < days < 365:
                        hired_total_time.append(days)
                except:
                    pass
            stage_counts["Offer"]["hired"] += 1
            continue

        # Get current stage name for active/rejected candidates
        cs = app.get("current_stage") or {}
        if not cs or not cs.get("id"):
            continue
        stage_id = cs["id"]
        stage_name = stage_names.get(stage_id, cs.get("name", ""))
        if not stage_name:
            continue

        # Classify into our pipeline
        classified = None
        for pname in PIPELINE:
            if stage_name.lower().strip() == pname.lower().strip():
                classified = pname
                break
        if not classified:
            classified = classify_stage(stage_name)
            bucket_to_name = {
                "application_review": "Application Review",
                "screens": "Phone Interview",
                "takehomes": "Take Home Test",
                "virtuals": "Virtual",
                "face_to_face": "Face to Face",
                "background_check": "Checkr",
            }
            if classified in bucket_to_name:
                classified = bucket_to_name[classified]
            else:
                continue

        if classified not in pipeline_order:
            continue

        rejected_at = app.get("rejected_at")

        if status == "rejected" and rejected_at:
            try:
                rejected_dt = datetime.fromisoformat(rejected_at.replace("Z", "+00:00")).replace(tzinfo=None)
                days = (rejected_dt - applied_dt).total_seconds() / 86400
                if 0 < days < 365:
                    rejected_at_stage[classified].append(days)
                    stage_counts[classified]["rejected"] += 1
            except:
                pass

        elif status == "active":
            days = (now - applied_dt).total_seconds() / 86400
            if 0 < days < 365:
                active_at_stage[classified].append(days)
                stage_counts[classified]["active"] += 1

    # ── RESULTS ──
    print(f"\n{'=' * 60}")
    print("PIPELINE SPEED (last %d weeks, ALL candidates)" % WEEKS_BACK)
    print("=" * 60)

    print(f"\n  Application → Hire")
    if hired_total_time:
        print(f"    Median: {med(hired_total_time):.0f} days  ({len(hired_total_time)} hires)")
    else:
        print(f"    No hires in this period")

    print(f"\n{'=' * 60}")
    print("TIME TO REJECTION BY STAGE")
    print("(Median days from application to rejection)")
    print("=" * 60)
    for name in PIPELINE:
        if name in rejected_at_stage:
            vals = rejected_at_stage[name]
            print(f"  Rejected at {name:25s}  {med(vals):5.0f} days median  ({len(vals)} candidates)")

    print(f"\n{'=' * 60}")
    print("CURRENTLY SITTING (active candidates)")
    print("(Median days since application)")
    print("=" * 60)
    for name in PIPELINE:
        if name in active_at_stage:
            vals = active_at_stage[name]
            print(f"  In {name:29s}  {med(vals):5.0f} days median  ({len(vals)} candidates)")

    print()


# ============================================================
# COMMAND: --companies  (companies of take-home candidates)
# ============================================================
def cmd_companies(token):
    """Pull company names for candidates who reached Take Home Test or beyond.
    Uses v1 for applications, v3 for candidate company data."""
    if V3_KEY == "YOUR_KEY_HERE" or V3_SECRET == "YOUR_SECRET_HERE":
        print("ERROR: The companies command needs your v3 credentials.")
        sys.exit(1)

    # Step 1: Use v1 to find candidate IDs who reached Take Home+
    cutoff = datetime.now() - timedelta(weeks=WEEKS_BACK)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00Z")

    print(f"Step 1: Finding candidates who reached Take Home+ (last {WEEKS_BACK} weeks)...\n")
    all_apps = v1_get("applications", {"created_after": cutoff_str})
    print(f"  Found {len(all_apps)} applications")

    # Build stage name lookup
    jobs = v1_get("jobs", {"status": "open"})
    job_names = {j["id"]: j["name"] for j in jobs if "id" in j}
    stage_names = {}
    for job in jobs:
        if "id" in job:
            try:
                stages = v1_get(f"jobs/{job['id']}/stages")
                for s in stages:
                    stage_names[s["id"]] = s["name"]
            except:
                pass

    TAKEHOME_AND_BEYOND = {"take home test", "take home", "technical assessment",
                           "virtual", "virtual interview", "video interview",
                           "face to face", "onsite", "in-person", "in person",
                           "checkr", "background check", "offer"}

    candidate_ids = set()
    app_jobs = {}

    for app in all_apps:
        status = app.get("status", "active")
        cs = app.get("current_stage") or {}
        stage_name = ""
        if isinstance(cs, dict) and cs.get("id"):
            stage_name = stage_names.get(cs["id"], cs.get("name", "")).lower().strip()

        reached = stage_name in TAKEHOME_AND_BEYOND or status == "hired"

        if reached:
            cid = app.get("candidate_id")
            if cid:
                candidate_ids.add(cid)
                app_jobs_list = app.get("jobs", [])
                if app_jobs_list:
                    jid = app_jobs_list[0].get("id") if isinstance(app_jobs_list[0], dict) else app_jobs_list[0]
                    app_jobs[cid] = job_names.get(jid, "Unknown")

    print(f"  {len(candidate_ids)} candidates reached Take Home Test or beyond")

    # Step 2: Use v3 to fetch ALL candidates, then match
    print(f"\nStep 2: Fetching all candidates via v3 API (bulk)...")
    v3_token = get_v3_token()
    all_candidates = v3_get(v3_token, "candidates")
    print(f"  Pulled {len(all_candidates)} candidates")

    # Build lookup by candidate ID
    cand_lookup = {}
    for c in all_candidates:
        cid = c.get("id")
        if cid:
            cand_lookup[cid] = c

    # Match against our take-home candidate IDs
    companies = []
    matched = 0
    for cid in candidate_ids:
        c = cand_lookup.get(cid)
        if c:
            matched += 1
            company = c.get("company") or "Unknown"
            name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
            job = app_jobs.get(cid, "Unknown")
            companies.append({
                "company": company,
                "job": job,
                "candidate": name,
            })

    print(f"  Matched {matched}/{len(candidate_ids)} candidates")

    print(f"\n{'=' * 70}")
    print(f"COMPANIES OF CANDIDATES WHO REACHED TAKE HOME+ ({len(companies)} candidates)")
    print("=" * 70)

    company_counts = Counter(c["company"] for c in companies)
    for comp, count in sorted(company_counts.items(), key=lambda x: -x[1]):
        jobs_at = set(c["job"] for c in companies if c["company"] == comp)
        print(f"  {comp:45s} ({count}x) — {', '.join(jobs_at)}")

    unique_companies = sorted(set(c["company"] for c in companies if c["company"] != "Unknown"))
    print(f"\n{'=' * 70}")
    print(f"UNIQUE COMPANIES ({len(unique_companies)})")
    print("=" * 70)
    for comp in unique_companies:
        print(f"  {comp}")


# ============================================================
# COMMAND: --titles  (job titles of screen+ candidates)
# ============================================================
def cmd_titles(token):
    """Pull current job titles for candidates who reached Screen or beyond.
    Uses v1 for applications, v3 for candidate title data."""
    if V3_KEY == "YOUR_KEY_HERE" or V3_SECRET == "YOUR_SECRET_HERE":
        print("ERROR: The titles command needs your v3 credentials.")
        sys.exit(1)

    cutoff = datetime.now() - timedelta(weeks=WEEKS_BACK)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00Z")

    print(f"Step 1: Finding candidates who reached Screen+ (last {WEEKS_BACK} weeks)...\n")
    all_apps = v1_get("applications", {"created_after": cutoff_str})
    print(f"  Found {len(all_apps)} applications")

    jobs = v1_get("jobs", {"status": "open"})
    job_names = {j["id"]: j["name"] for j in jobs if "id" in j}
    stage_names = {}
    for job in jobs:
        if "id" in job:
            try:
                stages = v1_get(f"jobs/{job['id']}/stages")
                for s in stages:
                    stage_names[s["id"]] = s["name"]
            except:
                pass

    SCREEN_AND_BEYOND = {"phone interview", "phone screen", "recruiter screen",
                         "take home test", "take home", "technical assessment",
                         "virtual", "virtual interview", "video interview",
                         "face to face", "onsite", "in-person", "in person",
                         "checkr", "background check", "offer"}

    candidate_ids = set()
    app_jobs = {}

    for app in all_apps:
        status = app.get("status", "active")
        cs = app.get("current_stage") or {}
        stage_name = ""
        if isinstance(cs, dict) and cs.get("id"):
            stage_name = stage_names.get(cs["id"], cs.get("name", "")).lower().strip()

        reached = stage_name in SCREEN_AND_BEYOND or status == "hired"

        if reached:
            cid = app.get("candidate_id")
            if cid:
                candidate_ids.add(cid)
                app_jobs_list = app.get("jobs", [])
                if app_jobs_list:
                    jid = app_jobs_list[0].get("id") if isinstance(app_jobs_list[0], dict) else app_jobs_list[0]
                    app_jobs[cid] = job_names.get(jid, "Unknown")

    print(f"  {len(candidate_ids)} candidates reached Screen or beyond")

    print(f"\nStep 2: Fetching title data via v3 API (bulk)...")
    v3_token = get_v3_token()
    all_candidates = v3_get(v3_token, "candidates")
    print(f"  Pulled {len(all_candidates)} candidates")

    cand_lookup = {}
    for c in all_candidates:
        cid = c.get("id")
        if cid:
            cand_lookup[cid] = c

    titles = []
    matched = 0
    for cid in candidate_ids:
        c = cand_lookup.get(cid)
        if c:
            matched += 1
            title = c.get("title") or "Unknown"
            job = app_jobs.get(cid, "Unknown")
            titles.append({"title": title, "job": job})

    print(f"  Matched {matched}/{len(candidate_ids)} candidates")

    # Group and count titles
    title_counts = Counter(t["title"] for t in titles)

    print(f"\n{'=' * 70}")
    print(f"JOB TITLES OF SCREEN+ CANDIDATES ({len(titles)} candidates)")
    print("=" * 70)
    for title, count in sorted(title_counts.items(), key=lambda x: -x[1]):
        if count >= 2:
            print(f"  {title:50s} ({count}x)")

    print(f"\n{'=' * 70}")
    print(f"ALL TITLES (including singles)")
    print("=" * 70)
    for title, count in sorted(title_counts.items(), key=lambda x: -x[1]):
        print(f"  {title:50s} ({count}x)")


# ============================================================
# COMMAND: --sources  (source effectiveness analysis)
# ============================================================
def cmd_sources(token):
    """Analyze which candidate sources produce the best pipeline progression."""
    if not V1_API_KEY:
        print("ERROR: Needs your v1 API key.")
        sys.exit(1)

    cutoff = datetime.now() - timedelta(weeks=WEEKS_BACK)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00Z")

    print(f"Pulling all applications from last {WEEKS_BACK} weeks...\n")
    all_apps = v1_get("applications", {"created_after": cutoff_str})
    print(f"  Found {len(all_apps)} applications")

    # Pull offers separately (like the funnel command does)
    print("  Fetching offers...")
    offers = v1_get("offers", {"created_after": cutoff_str})
    print(f"  Found {len(offers)} offers")

    # Build app_id -> source lookup
    app_source = {}
    for app in all_apps:
        aid = app.get("id")
        source = app.get("source") or {}
        source_name = "Unknown"
        if isinstance(source, dict):
            source_name = source.get("public_name") or source.get("name") or "Unknown"
        app_source[aid] = source_name

    # Build set of app_ids that got offers / hires
    offer_apps = set()
    hire_apps = set()
    for offer in offers:
        aid = offer.get("application_id")
        if aid:
            offer_apps.add(aid)
            if offer.get("status") == "accepted":
                hire_apps.add(aid)

    # Build stage lookup
    jobs = v1_get("jobs", {"status": "open"})
    stage_names = {}
    for job in jobs:
        if "id" in job:
            try:
                stages = v1_get(f"jobs/{job['id']}/stages")
                for s in stages:
                    stage_names[s["id"]] = s["name"]
            except:
                pass

    STAGE_LEVEL = {
        "application review": 0,
        "phone interview": 1, "phone screen": 1, "recruiter screen": 1,
        "take home test": 2, "take home": 2, "technical assessment": 2,
        "virtual": 3, "virtual interview": 3, "video interview": 3,
        "face to face": 4, "onsite": 4, "in-person": 4, "in person": 4,
        "checkr": 5, "background check": 5,
        "offer": 6,
    }

    source_data = defaultdict(lambda: {
        "total": 0, "screen": 0, "takehome": 0, "virtual": 0,
        "face_to_face": 0, "offer": 0, "hired": 0
    })

    for app in all_apps:
        aid = app.get("id")
        source_name = app_source.get(aid, "Unknown")

        status = app.get("status", "active")
        cs = app.get("current_stage") or {}
        stage_name = ""
        if isinstance(cs, dict) and cs.get("id"):
            stage_name = stage_names.get(cs["id"], cs.get("name", "")).lower().strip()

        level = STAGE_LEVEL.get(stage_name, -1)

        # Boost level if they got an offer or hire (covers null current_stage)
        if aid in hire_apps:
            level = max(level, 7)
        elif aid in offer_apps:
            level = max(level, 6)

        sd = source_data[source_name]
        sd["total"] += 1
        if level >= 1:
            sd["screen"] += 1
        if level >= 2:
            sd["takehome"] += 1
        if level >= 3:
            sd["virtual"] += 1
        if level >= 4:
            sd["face_to_face"] += 1
        if level >= 6:
            sd["offer"] += 1
        if level >= 7:
            sd["hired"] += 1

    # Sanity totals
    totals = {"total": 0, "screen": 0, "takehome": 0, "virtual": 0, "face_to_face": 0, "offer": 0, "hired": 0}
    for name, d in source_data.items():
        for k in totals:
            totals[k] += d[k]
    print(f"\n  TOTALS: {totals['total']} apps, {totals['screen']} screens, {totals['takehome']} TH, {totals['virtual']} virt, {totals['face_to_face']} F2F, {totals['offer']} offers, {totals['hired']} hires")

    # Sort by total volume
    sorted_sources = sorted(source_data.items(), key=lambda x: -x[1]["total"])

    print(f"\n{'=' * 90}")
    print(f"SOURCE EFFECTIVENESS (last {WEEKS_BACK} weeks)")
    print("=" * 90)
    print(f"  {'Source':35s} {'Apps':>6s} {'Screen':>8s} {'TH':>6s} {'Virt':>6s} {'F2F':>6s} {'Offer':>6s} {'Hire':>6s} {'Screen%':>8s}")
    print(f"  {'-'*35} {'-'*6} {'-'*8} {'-'*6} {'-'*6} {'-'*6} {'-'*6} {'-'*6} {'-'*8}")

    for name, d in sorted_sources:
        if d["total"] < 3:
            continue
        scr_pct = f"{d['screen']/d['total']*100:.1f}%" if d["total"] else "—"
        print(f"  {name:35s} {d['total']:6d} {d['screen']:8d} {d['takehome']:6d} {d['virtual']:6d} {d['face_to_face']:6d} {d['offer']:6d} {d['hired']:6d} {scr_pct:>8s}")

    # Also output top sources by screen conversion rate (min 10 applicants)
    print(f"\n{'=' * 90}")
    print(f"TOP SOURCES BY SCREEN RATE (min 10 applicants)")
    print("=" * 90)
    qualified = [(n, d) for n, d in source_data.items() if d["total"] >= 10]
    for name, d in sorted(qualified, key=lambda x: -x[1]["screen"]/max(x[1]["total"],1)):
        pct = d["screen"] / d["total"] * 100
        print(f"  {name:35s} {pct:5.1f}% screen rate  ({d['screen']}/{d['total']} apps, {d['hired']} hires)")

    # Small sources with surprisingly good conversion
    print(f"\n{'=' * 90}")
    print(f"HIDDEN GEMS (3-9 applicants, at least 1 screen)")
    print("=" * 90)
    gems = [(n, d) for n, d in source_data.items() if 3 <= d["total"] <= 9 and d["screen"] >= 1]
    for name, d in sorted(gems, key=lambda x: -x[1]["screen"]/max(x[1]["total"],1)):
        pct = d["screen"] / d["total"] * 100
        print(f"  {name:35s} {pct:5.1f}% screen rate  ({d['screen']}/{d['total']} apps)")


# ============================================================
# COMMAND: --stages  (show all stages + candidate counts)
# ============================================================
def cmd_stages(token):
    """Show all job stages with active candidate counts — uses v1 API."""
    if not V1_API_KEY:
        print("ERROR: The stages command needs your v1 API key.")
        print('Add: V1_API_KEY = "your_v1_key_here"')
        sys.exit(1)

    print("Fetching job stages...\n")

    all_stages = v1_get("job_stages")
    jobs_map = {}
    for stage in all_stages:
        job_id = stage.get("job_id")
        if job_id not in jobs_map:
            jobs_map[job_id] = []
        jobs_map[job_id].append({
            "id": stage.get("id"),
            "name": stage.get("name"),
            "priority": stage.get("priority", 0),
        })

    print(f"  Found {len(all_stages)} stages across {len(jobs_map)} jobs")
    print("  Fetching jobs...")
    jobs = v1_get("jobs", {"status": "open"})
    job_names = {j["id"]: j["name"] for j in jobs if "id" in j}

    print("  Fetching active applications...")
    applications = v1_get("applications", {"status": "active"})
    print(f"  Found {len(applications)} active applications")

    # Count per stage
    global_stage_counts = defaultdict(int)
    job_stage_counts = defaultdict(lambda: defaultdict(int))

    for app in applications:
        cs = app.get("current_stage") or {}
        stage_name = cs.get("name", "Unknown") if isinstance(cs, dict) else "Unknown"
        if stage_name == "Unknown":
            continue
        global_stage_counts[stage_name] += 1
        app_jobs = app.get("jobs", [])
        for j in app_jobs:
            jid = j.get("id") if isinstance(j, dict) else j
            job_stage_counts[jid][stage_name] += 1

    total_active = sum(global_stage_counts.values())

    print(f"\n{'=' * 60}")
    print("UNIQUE STAGE NAMES — with active candidate counts")
    print("=" * 60)
    for name, count in sorted(global_stage_counts.items(), key=lambda x: -x[1]):
        bucket = classify_stage(name)
        tag = f" → mapped to '{bucket}'" if bucket else ""
        print(f"  {name}: {count} candidates{tag}")
    print(f"\n  TOTAL ACTIVE: {total_active} candidates")

    print(f"\n{'=' * 60}")
    print("STAGES BY JOB (with candidate counts)")
    print("=" * 60)
    for job_id in sorted(job_stage_counts.keys(), key=lambda x: job_names.get(x, "")):
        jn = job_names.get(job_id)
        if not jn:
            continue
        counts = job_stage_counts[job_id]
        total = sum(counts.values())
        if total == 0 and "--all" not in sys.argv:
            continue
        print(f"\n  {jn} ({total} active)")
        for sname, c in sorted(counts.items(), key=lambda x: -x[1]):
            bar = "█" * min(c, 40) if c > 0 else "·"
            print(f"    {sname:30s} {c:4d}  {bar}")


# ============================================================
# COMMAND: default (weekly funnel data per job)
# ============================================================
def cmd_funnel(token):
    """Pull weekly funnel stats grouped by job.

    Methodology:
      - responses / application_review: by applied_at week
      - screens:      candidate is at phone screen OR ABOVE (active or rejected there)
      - takehomes:    candidate is at take home OR ABOVE
      - virtuals:     candidate is at virtual OR ABOVE
      - face_to_face: candidate is at F2F OR ABOVE
      - background_check: candidate is at bg check OR ABOVE
      - Date used: rejected_at for rejected candidates, last_activity_at for active
      - Active apps pulled without date cutoff (catches long-pipeline candidates)
      - Rejected apps filtered to last_activity_at within our window
      - offers: by offer created_at week
      - hires:  applications with status "hired", bucketed by offer starts_at
                (start date); future start dates excluded
    """
    if not V1_API_KEY:
        print("ERROR: The funnel command needs your v1 API key.")
        sys.exit(1)

    cutoff = datetime.now() - timedelta(weeks=WEEKS_BACK)
    cutoff_str = cutoff.strftime("%Y-%m-%dT00:00:00Z")

    print(f"Pulling Greenhouse data for the last {WEEKS_BACK} weeks...")
    print(f"(Since {cutoff.strftime('%B %d, %Y')})\n")

    # Pull jobs (all statuses — hires may land on reqs that are now closed,
    # so we need closed job names too for attribution).
    print("Fetching jobs...")
    jobs = v1_get("jobs")
    job_names = {j["id"]: j["name"] for j in jobs if "id" in j}
    print(f"  Found {len(jobs)} jobs")

    # Active apps: pull ALL — some candidates applied long ago but are still in pipeline
    print("Fetching active applications (all)...")
    active_apps = v1_get("applications", {"status": "active"})
    print(f"  Found {len(active_apps)} active applications")

    # Rejected apps: only those with activity in our window
    print(f"Fetching rejected applications (active since {cutoff.strftime('%b %d')})...")
    rejected_apps = v1_get("applications", {"status": "rejected", "last_activity_after": cutoff_str})
    print(f"  Found {len(rejected_apps)} recently rejected applications")

    # New applications (for response/application_review counts): by applied_at
    print("Fetching new applications (by applied date)...")
    new_apps = v1_get("applications", {"created_after": cutoff_str})
    print(f"  Found {len(new_apps)} new applications")

    # Hired applications — source of truth for hires (status flips to "hired")
    print("Fetching hired applications...")
    hired_apps = v1_get("applications", {"status": "hired"})
    print(f"  Found {len(hired_apps)} hired applications")

    # Pull offers. Wide window (52w) so a recently-started hire whose offer was
    # created months earlier still has a start date available. We build the
    # latest accepted offer per application for hire dates, and separately
    # window-filter for the weekly "offers" count.
    print("Fetching offers...")
    offers_cutoff = (datetime.now() - timedelta(weeks=52)).strftime("%Y-%m-%dT00:00:00Z")
    all_offers = v1_get("offers", {"created_after": offers_cutoff})
    offer_by_app = {}
    for o in all_offers:
        if o.get("status") != "accepted":
            continue
        aid = o.get("application_id")
        if aid is None:
            continue
        prev = offer_by_app.get(aid)
        if not prev or o.get("created_at", "") > prev.get("created_at", ""):
            offer_by_app[aid] = o
    offers = [o for o in all_offers if o.get("created_at", "") >= cutoff_str]
    print(f"  Found {len(offers)} offers in window, {len(offer_by_app)} accepted (for hires)")

    BLANK = lambda: {
        "inmails": 0, "responses": 0, "application_review": 0,
        "screens": 0, "takehomes": 0, "virtuals": 0,
        "face_to_face": 0, "background_check": 0, "offers": 0, "hires": 0,
    }

    # Stage level — higher = further in pipeline
    BUCKET_LEVEL = {
        "screens": 1,
        "takehomes": 2,
        "virtuals": 3,
        "face_to_face": 4,
        "background_check": 5,
    }
    STAGE_BUCKETS = ["screens", "takehomes", "virtuals", "face_to_face", "background_check"]

    weekly_by_job = defaultdict(lambda: defaultdict(BLANK))
    weekly_total = defaultdict(BLANK)
    app_to_job = {}
    detected_stages = defaultdict(int)

    def get_job_name(app):
        for j in app.get("jobs", []):
            jid = j.get("id") if isinstance(j, dict) else j
            if jid in job_names:
                return job_names[jid]
        return "Unknown"

    print("\nComputing weekly funnel...")

    # ── 1. Application review / responses — by applied_at ──
    for app in new_apps:
        aid = app.get("id")
        job_name = get_job_name(app)
        app_to_job[aid] = job_name
        applied = app.get("applied_at") or app.get("created_at", "")
        if not applied:
            continue
        try:
            week = get_monday(datetime.fromisoformat(applied.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            continue
        weekly_total[week]["responses"] += 1
        weekly_by_job[job_name][week]["responses"] += 1
        weekly_total[week]["application_review"] += 1
        weekly_by_job[job_name][week]["application_review"] += 1

    # ── 2. Stage counts — active + recently rejected ──
    #
    # Date logic:
    #   REJECTED candidates: use rejected_at — we know exactly when they left the pipeline
    #     and at what stage, so this is reliable for all stages.
    #
    #   ACTIVE candidates: trickier. last_activity_at updates on ANY activity (emails,
    #     notes, moves), not just stage transitions. So we only trust it when the candidate
    #     is at EXACTLY screen stage — that's likely when they were just moved there.
    #     For candidates already past screen (takehome+), we don't know when the screen
    #     happened, so we count them in the CURRENT week only (pipeline snapshot).
    #
    # Cumulative: a candidate at takehome is counted in screens AND takehomes.

    current_week = get_monday(datetime.now())
    window_start = get_monday(cutoff)

    # Active + rejected + hired. Hired candidates have null current_stage but
    # cleared the full funnel, so they count at every stage bucket.
    stage_apps = active_apps + rejected_apps + hired_apps
    for app in stage_apps:
        aid = app.get("id")
        status = app.get("status", "active")

        job_name = get_job_name(app)
        if aid not in app_to_job:
            app_to_job[aid] = job_name

        if status == "hired":
            date_str = app.get("last_activity_at")
            if not date_str:
                continue
            try:
                stage_week = get_monday(datetime.fromisoformat(date_str.replace("Z", "+00:00")))
            except (ValueError, TypeError):
                continue
            if stage_week < window_start or stage_week > current_week:
                continue
            for b in STAGE_BUCKETS:
                weekly_total[stage_week][b] += 1
                weekly_by_job[job_name][stage_week][b] += 1
            continue

        cs = app.get("current_stage") or {}
        if not isinstance(cs, dict) or not cs.get("name"):
            continue

        stage_name = cs["name"]
        detected_stages[stage_name] += 1
        bucket = classify_stage(stage_name)
        if not bucket or bucket not in BUCKET_LEVEL:
            continue

        level = BUCKET_LEVEL[bucket]

        if status == "rejected":
            date_str = app.get("rejected_at") or app.get("last_activity_at")
        else:
            date_str = app.get("last_activity_at")

        if not date_str:
            continue
        try:
            stage_week = get_monday(datetime.fromisoformat(date_str.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            continue

        if stage_week < window_start or stage_week > current_week:
            continue

        # Cumulative: a candidate at level N counts at every stage 1 through N.
        for i in range(level):
            b = STAGE_BUCKETS[i]
            weekly_total[stage_week][b] += 1
            weekly_by_job[job_name][stage_week][b] += 1

    # ── 3. Offers (count) — by offer created_at week ──
    for offer in offers:
        created = offer.get("created_at", "")
        if not created:
            continue
        try:
            week = get_monday(datetime.fromisoformat(created.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            continue
        offer_job = app_to_job.get(offer.get("application_id"), "Unknown")
        weekly_total[week]["offers"] += 1
        weekly_by_job[offer_job][week]["offers"] += 1

    # ── 4. Hires — from applications with status "hired" ──
    # Greenhouse flips the application status to "hired", which is the source of
    # truth. Bucket by the offer's START date (starts_at) so a hire counts in the
    # week they actually start; fall back to resolved_at, then last_activity_at.
    # Skip future start dates — someone who hasn't started yet isn't a hire yet.
    # Attributed to the application's job.
    window_start = get_monday(cutoff)
    for app in hired_apps:
        aid = app.get("id")
        job_name = get_job_name(app)
        if aid not in app_to_job:
            app_to_job[aid] = job_name
        off = offer_by_app.get(aid, {})
        date_str = off.get("starts_at") or off.get("resolved_at") or app.get("last_activity_at")
        if not date_str:
            continue
        try:
            hw = get_monday(datetime.fromisoformat(date_str.replace("Z", "+00:00")))
        except (ValueError, TypeError):
            continue
        if hw < window_start or hw > current_week:
            continue
        weekly_total[hw]["hires"] += 1
        weekly_by_job[job_name][hw]["hires"] += 1

    # Format output
    output = {"All": []}
    for wd in sorted(weekly_total.keys(), reverse=True):
        entry = {"weekOf": wd}
        entry.update(weekly_total[wd])
        output["All"].append(entry)

    for jn, wdata in weekly_by_job.items():
        jweeks = []
        for wd in sorted(wdata.keys(), reverse=True):
            entry = {"weekOf": wd}
            entry.update(wdata[wd])
            jweeks.append(entry)
        output[jn] = jweeks

    found_jobs = sorted(k for k in output.keys() if k != "All")
    print(f"\n  Found data for {len(found_jobs)} jobs:")
    for jn in found_jobs:
        total_apps = sum(w.get("responses", 0) for w in output[jn])
        print(f"    {jn}: {total_apps} applications")

    print(f"\n{'=' * 60}")
    print("STAGE NAMES DETECTED (from current_stage):")
    print("=" * 60)
    for name, count in sorted(detected_stages.items(), key=lambda x: -x[1]):
        bucket = classify_stage(name)
        tag = f" → '{bucket}'" if bucket else " (unmapped — add to STAGE_MAPPING)"
        print(f"  {name}: {count}{tag}")

    print(f"\n{'=' * 60}")
    print("WEEKLY FUNNEL DATA (by job)")
    print("=" * 60)
    print("\nPaste this JSON into your dashboard's import feature:\n")

    output_json = json.dumps(output, indent=2)
    print(output_json)

    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        outfile = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "greenhouse_funnel.json"
        with open(outfile, "w") as f:
            f.write(output_json)
        print(f"\nSaved to {outfile}")

    print(f"""
NOTES:
  - Output grouped by job: {{"All": [...], "Job Name": [...], ...}}
  - 'inmails' is always 0 (LinkedIn data — merged in dashboard)
  - 'responses' / 'application_review' = new applications that week (by applied_at)
  - Stage counts: bucketed by last_activity_at (active) or rejected_at (rejected)
    — approximates when the candidate was last worked in the pipeline
  - Counts are cumulative: a candidate at take-home is also counted in screens
  - 'offers' = offers created that week; 'hires' = accepted offers (by resolved_at)
""")


# ============================================================
# MAIN
# ============================================================
def main():
    # All commands use v1 now
    if V1_API_KEY == "YOUR_V1_KEY_HERE":
        print("=" * 60)
        print("  Please set your Greenhouse v1 API key!")
        print()
        print("  Edit this file and replace YOUR_V1_KEY_HERE")
        print("  with your Harvest API key from Greenhouse")
        print("  Or set: export GREENHOUSE_API_KEY=your_key")
        print("=" * 60)
        sys.exit(1)

    if "--timing" in sys.argv:
        cmd_timing(None)
    elif "--stages" in sys.argv:
        cmd_stages(None)
    elif "--companies" in sys.argv:
        cmd_companies(None)
    elif "--titles" in sys.argv:
        cmd_titles(None)
    elif "--sources" in sys.argv:
        cmd_sources(None)
    else:
        cmd_funnel(None)


if __name__ == "__main__":
    main()
