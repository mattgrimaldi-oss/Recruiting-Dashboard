# Hire automation (DocuSign → Checkr → Greenhouse)

Phase one of the post-offer pipeline. When an offer letter is signed by **both
parties** in DocuSign, the system automatically:

1. Sends a **Checkr** background-check invitation to the candidate.
2. Uploads the **signed offer PDF** to the candidate in Greenhouse.
3. Marks the Greenhouse application **hired**.

It's **sign-gated** ("build A"): all three fire immediately on `envelope-completed`.
The hired mark happens before the Checkr result is known — walking that back if a
report comes back non-clear is a manual process for now (that's a future phase).

## How it fits together

```
Offer generator (index.html)
  └─ picks a Greenhouse candidate (searchable picker)
  └─ POST /api/send-to-docusign  ──► stamps greenhouse_candidate_id / _application_id /
                                     candidate_email / start_date as envelope custom fields,
                                     and records the mapping in Neon (best-effort)
        │
        ▼  (recruiter reviews & sends from DocuSign; both parties sign)
DocuSign Connect  ──envelope-completed──►  POST /api/docusign-webhook
        │
        ├─ verify Connect HMAC over the raw body
        ├─ ACK 200 fast, then (waitUntil) do the work:
        │     1. Checkr invitation   (lib/checkr.js)
        │     2. upload signed PDF    (lib/greenhouse.js)  ← fetched via lib/docusign.js
        │     3. mark hired           (lib/greenhouse.js)
        └─ idempotent on envelopeId via the hire_events table (lib/db.js)
```

### Files
| File | Role |
| --- | --- |
| `api/docusign-webhook.js` | Connect listener: verify → ACK → run pipeline |
| `api/send-to-docusign.js` | (edited) stamps GH ids as envelope custom fields + records mapping |
| `lib/hire-pipeline.js` | Orchestrates the 3 steps, resumable per-step |
| `lib/docusign.js` | JWT auth, Connect HMAC verify, combined-PDF fetch, custom-field read |
| `lib/checkr.js` | Create candidate + send invitation |
| `lib/greenhouse.js` | current_offer read, attachment upload, mark hired |
| `lib/db.js` | Neon client + idempotency/record helpers |
| `db/schema.sql` | `hire_events` table |

## Setup

### 1. Database (Neon)
Create a Neon Postgres database (reuse your existing Neon project if you like) and
apply the schema:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

### 2. Environment variables (Vercel → Project → Settings → Environment Variables)
Existing DocuSign vars are already set. Add:

| Var | What | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon connection string | Use the **pooled** connection string |
| `DOCUSIGN_CONNECT_HMAC_KEY` | Connect HMAC key | From the Connect config (step 3) |
| `CHECKR_API_KEY` | Checkr secret key | Staging key while testing |
| `CHECKR_PACKAGE_SLUG` | The one default package slug | Single package for all hires |
| `CHECKR_BASE_URL` | Checkr host | Defaults to `api.checkr-staging.com`; set `api.checkr.com` for prod |
| `CHECKR_WORK_LOCATIONS` | JSON array, optional | Defaults to `[{"country":"US"}]` |
| `GREENHOUSE_API_KEY` | Harvest **v1** key | Needs `applications: edit`, `candidates: edit`, and offers read |
| `GREENHOUSE_ON_BEHALF_OF` | Greenhouse user id | Required on all Harvest writes (your user id) |
| `GH_ATTACHMENT_TYPE` | optional | Defaults to `signed_offer_letter` |
| `HIRE_AUTOMATION_DRY_RUN` | `true` / `false` | **Defaults to true.** See below. |

### 3. DocuSign Connect
Create a **Connect** configuration (Admin → Connect → Add Configuration → Custom):
- **URL:** `https://recruiting-dashboard-woad.vercel.app/api/docusign-webhook`
- **Event:** `Envelope Completed` only.
- **Include:** enable **"Include HMAC Signature"** and set the key; put that same key in
  `DOCUSIGN_CONNECT_HMAC_KEY`. (Custom fields ride along in the payload automatically;
  the handler also has DB + API fallbacks if they're ever missing.)
- Format: JSON.

## Dry-run and going live

`HIRE_AUTOMATION_DRY_RUN` defaults to **true**. In dry-run, every Checkr and Greenhouse
write is **logged, not executed** — the handler still verifies the signature, resolves the
candidate, fetches the signed PDF, and records to `hire_events`, but the log shows exactly
what it *would* send. Nothing hits Checkr or your live Greenhouse ATS.

To validate end to end: send a real offer, sign it as both parties, then check the Vercel
function logs for the `[dry-run]` lines and the `Hire pipeline complete` summary, and the
`hire_events` row. When it looks right, set `HIRE_AUTOMATION_DRY_RUN=false` and redeploy.

## Reliability notes
- **Idempotency:** keyed on `envelopeId`. Connect retries and duplicate deliveries are
  deduped by the `claimForProcessing` gate; a failed run leaves the row `failed` so a
  later retry resumes only the steps that didn't complete.
- **Fast ACK:** the handler returns 200 before doing the work (via `waitUntil`) so Connect
  doesn't treat us as failed and retry-storm.
- **HMAC:** the raw request body is verified before anything else; bad signatures get 401.

## Known Greenhouse quirks to watch (from prior work)
- Individual-candidate Harvest calls have returned **403** on scope gaps — confirm the key
  has `applications: edit` + candidate/offer access before flipping off dry-run.
- Marking hired uses `POST /v1/applications/{id}/hire` directly (no Greenhouse offer object
  required). `start_date` comes from the offer form; if absent we try the application's
  `current_offer`. Some orgs require a start date — include one on the offer.

## Not in scope (phase one)
- **No Checkr webhook receiver.** Phase one only *sends* the invitation and stores the
  Checkr candidate/invitation ids in `hire_events`. Consuming Checkr `report.completed`
  (check-gating / adverse-action) is phase 2 and can read those records.
- Onboarding/HRIS kickoff is phase 3.
