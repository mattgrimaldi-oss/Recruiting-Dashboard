# UI Redesign Brief — Flip Recruiting Hub

Prepared 2026-07-20. Scope was agreed with Matt in a prior session; do not re-ask these questions. Ask only if something here is genuinely ambiguous.

## Goal
Redesign the UI of `index.html` (single-file React app, Babel in-browser, ~370KB). Keep ALL existing content and functionality — this is a reskin + layout restructure, not a rebuild.

## Design direction
1. **Sidebar navigation** replaces the current horizontal tab bar.
   - Left sidebar, glassmorphic (frosted translucent panels, subtle borders, rounded corners).
   - **Collapsible**: a toggle button collapses it to an icon-only rail (~64px) and back to full width (~240px, icons + labels). Starts expanded. Smooth width animation.
   - Structure: app logo/title at top, menu items with icons, subtle section dividers.
2. **Glassmorphic dark theme** across the whole app, modeled on a dark purple aesthetic:
   - Background: near-black with a large soft **purple gradient glow** (deep violet #1a1033-ish center tones fading to black, purple light bleeding from the edges — like a dark UI floating over a purple-lit backdrop).
   - Cards: translucent dark panels (`rgba(255,255,255,0.03-0.06)` fills, `backdrop-filter: blur`, 1px `rgba(255,255,255,0.08)` borders, large border radii ~16-20px).
   - Keep the existing Flip purple/indigo accent palette (#818cf8, #a78bfa, #c084fc etc.) — it already matches.
   - Typography: keep Plus Jakarta Sans + JetBrains Mono already in use.
3. **Merge the Pipeline and InMail Analytics tabs into ONE dashboard page.** Pipeline funnel content on top, InMail analytics content below (or a tasteful two-column arrangement where it fits). All existing charts/stats from both tabs must survive. The job filter + time period filter stay and continue to apply to pipeline data.
4. **New analytics on the merged dashboard:**
   - **Trend arrows on stat cards**: each headline stat (Applicants, Screens, Offers, Hires, InMails Sent, Response Rate, etc.) shows ▲/▼ % vs the prior equivalent period (e.g. this 30 days vs previous 30 days), green up / red down (for response-type metrics up=good; for nothing here is down=good, keep it simple).
   - **Weekly activity heatmap**: calendar-style grid, one row per stage (Screens, Take Homes, Virtuals, F2F, Offers, Hires), one column per week, darker = busier. Data source: the same weekly data already powering the funnel (data.json weeks + INMAIL_WEEKLY).
5. **Chatbot becomes a floating bubble** (bottom-LEFT corner, per Matt's reference to "bottom left little bubble"):
   - Remove "Ask Flip AI" from the navigation entirely.
   - A circular glassmorphic bubble button; clicking it opens the existing chat UI in a panel that animates open (scale/slide + fade). Click outside or an X closes it.
   - Reuse the existing chat component/logic (fetches `/api/chat`) — do not rebuild its internals.
6. Remaining nav items: Dashboard (merged page), Offer Letter Generator, Applicant Screening. Keep their content as-is, just restyled to match the new theme.

## Hard constraints (from project memory — do not violate)
- **Never read index.html in full** — it's huge; read targeted sections via grep + offset/limit.
- **Never change the legal language** in the offer letter templates. Don't touch offer letter generation logic, DocuSign flow, salary/equity/OTE logic.
- Images stay base64-inline. No external asset URLs (except existing ones).
- Don't touch: `data.json`, `slackOffers` data, `INMAIL_WEEKLY` data, `RECRUITERS` data, manual entries logic (localStorage `flipManualEntries_v2`), the + buttons on Offer/Hire bars (keep them working in the new design), API endpoints, scheduled tasks.
- The app must keep working as a single static `index.html` (React + Babel in-browser).

## Verify + deploy workflow
- **Deploy as you go** (Matt's choice): after each coherent chunk, verify locally then deploy.
- Local preview: `python3 -m http.server <port>` in the project dir, view via browser tools (there's also `serve.py`).
- Verify each major piece renders (screenshot) before deploying — a Babel syntax error blanks the entire page.
- Deploy: `cd "/Users/matthewgrimaldi/Downloads/Recruiting Dashboard" && git add index.html && git commit -m "..." && git pull --rebase origin main && git push && source ~/.zshrc && vercel --prod --yes --scope flip-cx`
- Live URL: https://recruiting-dashboard-woad.vercel.app
- Commit/push/deploy without asking (standing permission in memory).

## Suggested order
1. Background gradient + glass card styles (theme foundation)
2. Sidebar (with collapse) replacing tab bar
3. Merge Pipeline + InMail into Dashboard page
4. Trend arrows, then heatmap
5. Chat bubble
6. Final pass: restyle Offer Letter Generator + Applicant Screening pages to match
