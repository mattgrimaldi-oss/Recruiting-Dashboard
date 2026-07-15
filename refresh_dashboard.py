#!/usr/bin/env python3
"""
Refresh dashboard data from Greenhouse + Google Calendar.
Run this whenever you want to update the dashboard:
  python3 refresh_dashboard.py
"""

import subprocess, json, sys, os

script_dir = os.path.dirname(os.path.abspath(__file__))
out_path = os.path.join(script_dir, "data.json")

# ── Step 1: Pull pipeline data from Greenhouse ────────────────────────────────
print("Pulling data from Greenhouse...")
result = subprocess.run(
    [sys.executable, os.path.join(script_dir, "greenhouse_v3.py")],
    capture_output=True, text=True
)

if result.returncode != 0:
    print("ERROR running greenhouse_v3.py:")
    print(result.stderr)
    sys.exit(1)

# Extract JSON from script output
marker = "Paste this JSON into your dashboard"
idx = result.stdout.find(marker)
if idx == -1:
    print("ERROR: Could not find JSON in script output.")
    sys.exit(1)

json_start = result.stdout.find("{", idx)
depth, json_end = 0, json_start
for i, c in enumerate(result.stdout[json_start:]):
    if c == "{": depth += 1
    elif c == "}":
        depth -= 1
        if depth == 0:
            json_end = json_start + i + 1
            break

data = json.loads(result.stdout[json_start:json_end])

# ── Step 2: Pull screen counts from Google Calendar ───────────────────────────
print("Pulling screen counts from Google Calendar...")
try:
    sys.path.insert(0, script_dir)
    from calendar_sync import get_weekly_screens
    weekly_screens, _, _, _ = get_weekly_screens()

    # Overwrite screens in "All" with calendar-accurate counts
    overwritten = 0
    for week in data.get("All", []):
        cal_count = weekly_screens.get(week["weekOf"])
        if cal_count is not None:
            week["screens"] = cal_count
            overwritten += 1

    print(f"  ✓ Overwrote screens for {overwritten} weeks with calendar data")

except Exception as e:
    print(f"  WARNING: Calendar sync failed ({e}) — using Greenhouse screen counts")

# ── Step 3: Write data.json ───────────────────────────────────────────────────
with open(out_path, "w") as f:
    json.dump(data, f)

all_weeks = data.get("All", [])
jobs = [k for k in data if k != "All"]
print(f"✓ {len(all_weeks)} weeks · {len(jobs)} jobs → data.json")
print(f"  Open http://localhost:3000 and reload to see updated data.")
