#!/usr/bin/env python3
"""
Google Calendar sync for recruiting pipeline.

Pulls screen meetings from Matt, Meghan, and Connor's calendars,
filters out internal @flipcx.com calls, cross-references candidate
emails with Greenhouse to attribute screens to specific jobs.

Usage:
  python3 calendar_sync.py                  # weekly screen counts by job
  python3 calendar_sync.py --show-events    # print every matched event
"""

import os, sys, warnings
warnings.filterwarnings("ignore")

from datetime import datetime, timedelta, timezone
from collections import defaultdict
from base64 import b64encode
import requests

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE  = os.path.join(SCRIPT_DIR, "google_credentials.json")
TOKEN_FILE  = os.path.join(SCRIPT_DIR, "google_token.json")
SCOPES      = ["https://www.googleapis.com/auth/calendar.readonly"]

SCREEN_CALENDARS = [
    "mattgrimaldi@flipcx.com",
    "meghan@flipcx.com",
    "connormcdermott@flipcx.com",
]

FLIPCX_DOMAIN  = "flipcx.com"
WEEKS_BACK     = 24
NEW_FORMAT_DATE = "2026-05-06"

V1_API_KEY  = os.environ.get("GREENHOUSE_API_KEY", "")
V3_KEY      = os.environ.get("GREENHOUSE_V3_KEY", "")
V3_SECRET   = os.environ.get("GREENHOUSE_V3_SECRET", "")


# ── Auth ──────────────────────────────────────────────────────────────────────

def get_calendar_service():
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def get_v3_token():
    cred = b64encode(f"{V3_KEY}:{V3_SECRET}".encode()).decode()
    resp = requests.post(
        "https://auth.greenhouse.io/token",
        headers={"Authorization": f"Basic {cred}", "Content-Type": "application/x-www-form-urlencoded"},
        data="grant_type=client_credentials",
    )
    return resp.json().get("access_token")


def v1_auth():
    token = b64encode(f"{V1_API_KEY}:".encode()).decode()
    return {"Authorization": f"Basic {token}"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_monday(dt_str):
    dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    monday = dt - timedelta(days=dt.weekday())
    return monday.strftime("%Y-%m-%d")


def is_internal(attendees):
    """True if every non-organiser attendee is @flipcx.com."""
    external = [
        a for a in attendees
        if not a.get("organizer") and FLIPCX_DOMAIN not in a.get("email", "")
    ]
    return len(external) == 0


def external_emails(attendees):
    return [
        a["email"].lower() for a in attendees
        if not a.get("organizer") and FLIPCX_DOMAIN not in a.get("email", "")
    ]


ONSITE_MARKERS = ["on site", "onsite", "on-site", "final", "face to face", "f2f", "in person", "in-person"]


def looks_like_virtual(title):
    """
    Virtual interview: 'interview [candidate name]' without onsite/final markers.
    Excludes 'Interview with Flip' (the duplicate candidate-facing event Greenhouse creates).
    """
    tl = (title or "").lower()
    if "interview" not in tl:
        return False
    if "debrief" in tl:
        return False
    # Exclude the candidate-facing duplicate Greenhouse creates
    if "interview with flip" in tl:
        return False
    # Exclude onsite/final — those are face-to-face
    if any(m in tl for m in ONSITE_MARKERS):
        return False
    return True


def looks_like_onsite(title):
    """
    Onsite / face-to-face / final-round interview.
    Title contains 'interview' AND an onsite marker (e.g. 'On Site', 'Final', 'Onsite').
    """
    tl = (title or "").lower()
    if "debrief" in tl:
        return False
    if "interview with flip" in tl:
        return False
    has_interview = "interview" in tl
    has_f2f = any(m in tl for m in ["face to face", "f2f"])
    if not has_interview and not has_f2f:
        return False
    return any(m in tl for m in ONSITE_MARKERS)


def looks_like_screen(title, calendar_id):
    tl = (title or "").lower()

    # Explicit "screen" / "screening" in title always counts — any calendar
    if "screen" in tl or "screening" in tl:
        return True

    skip = ["ooo", "out of office", "lunch", "block", "hold", "1:1",
            "team", "standup", "all hands", "debrief", "no meeting",
            "focus", "busy", "interview debrief", "onsite", "virtual",
            "take home", "face to face"]
    if any(p in tl for p in skip):
        return False

    if "mattgrimaldi@flipcx.com" in calendar_id:
        return "matthew grimaldi" in tl or "bdr intro call" in tl
    if "meghan@flipcx.com" in calendar_id:
        return "meghan" in tl
    if "connormcdermott@flipcx.com" in calendar_id:
        # "Meeting with Flip", "Flip - BDR Meeting", "Candidate Name and Connor", etc.
        return ("meeting with flip" in tl or
                "flip bdr meeting" in tl or
                "flip - bdr meeting" in tl or
                "and connor" in tl or
                "connor mcdermott" in tl or
                "w/ connor" in tl or
                "with connor" in tl)
    return False


# ── Greenhouse email → job lookup ─────────────────────────────────────────────

def build_email_job_map(emails):
    """
    Build {email: job_name} with just 3 bulk API calls — no per-email lookups.

    1. Pull all jobs (names)
    2. Pull all v3 candidates in bulk → build email→candidate_id map
    3. Pull all v1 applications → build candidate_id→job_name map
    Then match in memory.
    """
    if not emails:
        return {}

    # 1. Job names
    print("  Fetching jobs...")
    jobs_resp = requests.get(
        "https://harvest.greenhouse.io/v1/jobs",
        headers=v1_auth(), params={"per_page": 100, "status": "open"}
    ).json()
    job_names = {j["id"]: j["name"] for j in jobs_resp if "id" in j}

    # 2. All candidates via v3 — build email → candidate_id
    # v3 paginates via a cursor in the Link: rel="next" header. The cursor URL
    # is self-contained; adding extra params (e.g. per_page) alongside it
    # returns 0 records, so we only send params on the first request.
    print("  Fetching all candidates (v3 bulk)...")
    v3_token = get_v3_token()
    v3_headers = {"Authorization": f"Bearer {v3_token}"}
    email_to_cand = {}
    url = "https://harvest.greenhouse.io/v3/candidates"
    params = {"per_page": 500}
    total = 0
    while True:
        r = requests.get(url, headers=v3_headers, params=params)
        params = None  # cursor URL is self-contained; no extra params after page 1
        if not r.ok:
            break
        data = r.json()
        candidates = data if isinstance(data, list) else data.get("results", [])
        for c in candidates:
            cid = c.get("id")
            for ea in c.get("email_addresses", []):
                addr = (ea.get("value") or "").lower()
                if addr:
                    email_to_cand[addr] = cid
        total += len(candidates)
        link = r.headers.get("Link", "")
        next_url = None
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    next_url = part.split(";")[0].strip().strip("<>")
                    break
        if not next_url:
            break
        url = next_url
    print(f"  Loaded {total} candidates, {len(email_to_cand)} email addresses")

    # 3. All applications via v1 — build candidate_id → job_name
    print("  Fetching all applications (v1 bulk)...")
    cand_to_job = {}
    page = 1
    while True:
        r = requests.get(
            "https://harvest.greenhouse.io/v1/applications",
            headers=v1_auth(), params={"per_page": 100, "page": page}
        )
        if not r.ok:
            break
        apps = r.json()
        if not apps:
            break
        for app in apps:
            cid = app.get("candidate_id")
            if cid and cid not in cand_to_job:
                for j in app.get("jobs", []):
                    jid = j.get("id") if isinstance(j, dict) else j
                    if jid in job_names:
                        cand_to_job[cid] = job_names[jid]
                        break
        if len(apps) < 100:
            break
        page += 1
        if page > 150:  # safety cap
            break
    print(f"  Mapped {len(cand_to_job)} candidates to jobs")

    # 4. Match in memory
    email_job = {}
    for email in emails:
        cid = email_to_cand.get(email.lower())
        if cid:
            email_job[email] = cand_to_job.get(cid, "Unknown")
        else:
            email_job[email] = "Unknown"

    matched = sum(1 for v in email_job.values() if v != "Unknown")
    print(f"  Matched {matched}/{len(emails)} screen emails to a job")
    return email_job


# ── Main pull ─────────────────────────────────────────────────────────────────

def pull_screens(service, weeks_back=WEEKS_BACK, verbose=False):
    cutoff = (datetime.now(timezone.utc) - timedelta(weeks=weeks_back)).isoformat()
    now    = datetime.now(timezone.utc).isoformat()

    seen_screen_uids  = set()
    seen_virtual_uids = set()
    seen_onsite_uids  = set()
    raw_screens  = []
    raw_virtuals = []
    raw_onsites  = []

    for cal_id in SCREEN_CALENDARS:
        try:
            page_token = None
            cal_events = []
            while True:
                resp = service.events().list(
                    calendarId=cal_id,
                    timeMin=cutoff, timeMax=now,
                    singleEvents=True, orderBy="startTime",
                    maxResults=500, pageToken=page_token,
                ).execute()
                cal_events.extend(resp.get("items", []))
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break

            n_screens = n_virtuals = n_onsites = 0
            for ev in cal_events:
                if ev.get("status") == "cancelled":
                    continue

                title = ev.get("summary", "")
                start = ev.get("start", {})
                dt_str = start.get("dateTime") or start.get("date")
                if not dt_str:
                    continue

                attendees = ev.get("attendees", [])
                if attendees and is_internal(attendees):
                    continue

                uid  = ev.get("iCalUID", ev.get("id"))
                week = get_monday(dt_str)
                ext_emails = external_emails(attendees)
                ev_base = {"week": week, "date": dt_str[:10], "title": title,
                           "calendar": cal_id, "uid": uid, "emails": ext_emails, "job": "Unknown"}

                if looks_like_screen(title, cal_id) and uid not in seen_screen_uids:
                    seen_screen_uids.add(uid)
                    raw_screens.append(ev_base)
                    n_screens += 1
                elif looks_like_onsite(title) and uid not in seen_onsite_uids:
                    seen_onsite_uids.add(uid)
                    raw_onsites.append(ev_base)
                    n_onsites += 1
                elif looks_like_virtual(title) and uid not in seen_virtual_uids:
                    seen_virtual_uids.add(uid)
                    raw_virtuals.append(ev_base)
                    n_virtuals += 1

            print(f"  {cal_id}: {len(cal_events)} events → {n_screens} screens, {n_virtuals} virtuals, {n_onsites} onsites")

        except Exception as ex:
            print(f"  {cal_id}: ERROR — {ex}")

    # ── Cross-reference emails with Greenhouse ──
    all_emails = set(e for s in raw_screens for e in s["emails"])
    print(f"\n  Looking up {len(all_emails)} unique candidate emails in Greenhouse...")
    email_job = build_email_job_map(all_emails)
    print(f"  Matched {len(email_job)} of {len(all_emails)} to a job")

    for s in raw_screens:
        for email in s["emails"]:
            job = email_job.get(email)
            if job and job != "Unknown":
                s["job"] = job
                break

    return raw_screens, raw_virtuals, raw_onsites


def get_weekly_screens(weeks_back=WEEKS_BACK):
    """
    Returns:
      weekly_screens  — {week: screen_count}
      weekly_virtuals — {week: virtual_count}
      weekly_onsites  — {week: onsite_count}
      weekly_jobs     — {job_name: {week: screen_count}}
    """
    service = get_calendar_service()
    print("Pulling calendar screens...")
    screens, virtuals, onsites = pull_screens(service, weeks_back)

    weekly_screens  = defaultdict(int)
    weekly_virtuals = defaultdict(int)
    weekly_onsites  = defaultdict(int)
    weekly_jobs     = defaultdict(lambda: defaultdict(int))

    for s in screens:
        weekly_screens[s["week"]] += 1
        weekly_jobs[s["job"]][s["week"]] += 1
    for v in virtuals:
        weekly_virtuals[v["week"]] += 1
    for o in onsites:
        weekly_onsites[o["week"]] += 1

    return (dict(weekly_screens), dict(weekly_virtuals), dict(weekly_onsites),
            {k: dict(v) for k, v in weekly_jobs.items()})


if __name__ == "__main__":
    service = get_calendar_service()
    show_events = "--show-events" in sys.argv

    print(f"Pulling screens from {len(SCREEN_CALENDARS)} calendars (last {WEEKS_BACK} weeks)...\n")
    screens, virtuals, onsites = pull_screens(service, verbose=show_events)

    weekly_screens  = defaultdict(int)
    weekly_virtuals = defaultdict(int)
    weekly_onsites  = defaultdict(int)
    weekly_jobs     = defaultdict(lambda: defaultdict(int))
    for s in screens:
        weekly_screens[s["week"]] += 1
        weekly_jobs[s["job"]][s["week"]] += 1
    for v in virtuals:
        weekly_virtuals[v["week"]] += 1
    for o in onsites:
        weekly_onsites[o["week"]] += 1

    print(f"\n{'=' * 55}")
    print(f"SCREENS BY WEEK ({len(screens)} total)")
    print("=" * 55)
    for week in sorted(weekly_screens.keys(), reverse=True):
        print(f"  {week}: screens={weekly_screens[week]:3d}  virtuals={weekly_virtuals.get(week,0):3d}  onsites={weekly_onsites.get(week,0):3d}")

    print(f"\n{'=' * 55}")
    print("SCREENS BY JOB")
    print("=" * 55)
    for job in sorted(weekly_jobs.keys()):
        total = sum(weekly_jobs[job].values())
        print(f"  {job} ({total} total)")
        for week in sorted(weekly_jobs[job].keys(), reverse=True):
            print(f"    {week}: {weekly_jobs[job][week]}")

    if show_events:
        print(f"\n{'=' * 55}")
        print("MATCHED EVENTS")
        print("=" * 55)
        for ev in sorted(screens, key=lambda x: x["date"], reverse=True):
            cal_short = ev["calendar"].split("@")[0]
            print(f"  {ev['date']}  [{cal_short:12s}]  {ev['job']:30s}  {ev['title']}")
