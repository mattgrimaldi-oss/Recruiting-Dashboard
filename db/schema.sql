-- Hire-automation persistence (Neon Postgres).
-- One row per DocuSign envelope we act on. Keyed on envelope_id for idempotency:
-- DocuSign Connect retries deliveries, so the webhook skips any envelope already
-- in a terminal state. Future phases (adverse-action, onboarding kickoff) read
-- from this table, so keep the Greenhouse + Checkr ids durable here.
--
-- Apply once against your Neon database:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS hire_events (
  envelope_id           TEXT PRIMARY KEY,

  -- Greenhouse mapping, stashed on the envelope at offer-send time.
  candidate_id          TEXT,
  application_id        TEXT,
  candidate_name        TEXT,
  candidate_email       TEXT,
  start_date            DATE,

  -- Lifecycle: sent -> received -> processing -> completed | failed
  status                TEXT NOT NULL DEFAULT 'sent',
  dry_run               BOOLEAN NOT NULL DEFAULT TRUE,

  -- Per-step outcomes so a retry can resume rather than redo, and so a later
  -- phase can see exactly what happened.
  checkr_candidate_id   TEXT,
  checkr_invitation_id  TEXT,
  checkr_sent_at        TIMESTAMPTZ,

  gh_attachment_id      TEXT,
  gh_attachment_at      TIMESTAMPTZ,

  gh_hired_at           TIMESTAMPTZ,
  gh_offer_id           TEXT,

  last_error            TEXT,
  raw                   JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hire_events_status_idx      ON hire_events (status);
CREATE INDEX IF NOT EXISTS hire_events_application_idx ON hire_events (application_id);

-- Logged every time a recruiter generates an offer letter for a linked
-- Greenhouse candidate (before any DocuSign envelope exists). Fallback for
-- envelopes that reach envelope-completed with no custom fields — e.g. the
-- recruiter downloaded the PDF and created the DocuSign envelope manually
-- instead of using "Send to DocuSign". The webhook matches the signer's email
-- (and failing that, name) against this log to recover the candidate/application id.
CREATE TABLE IF NOT EXISTS offer_drafts (
  id              BIGSERIAL PRIMARY KEY,
  candidate_id    TEXT,
  application_id  TEXT,
  candidate_name  TEXT,
  candidate_email TEXT,
  start_date      DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offer_drafts_email_idx ON offer_drafts (lower(candidate_email));
CREATE INDEX IF NOT EXISTS offer_drafts_name_idx  ON offer_drafts (lower(candidate_name));
