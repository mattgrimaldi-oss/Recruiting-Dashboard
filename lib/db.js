// Neon serverless Postgres client + hire_events helpers.
//
// Uses @neondatabase/serverless (HTTP-based) so it works inside Vercel
// functions without connection pooling headaches. Everything degrades
// gracefully: if DATABASE_URL is unset, the helpers no-op / return null so a
// missing DB never takes down offer-sending. The webhook, however, treats the
// DB as required (it's the idempotency store) and will surface the error.

const { neon } = require('@neondatabase/serverless');

let _sql = null;
function client() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  _sql = neon(url);
  return _sql;
}

const dbEnabled = () => !!process.env.DATABASE_URL;

// Called from send-to-docusign at offer-send time. Best-effort: records the
// envelope -> Greenhouse mapping so the webhook can resolve it even if the
// envelope custom fields are somehow missing later.
async function recordEnvelopeSent({ envelopeId, candidateId, applicationId, candidateName, candidateEmail, startDate }) {
  const sql = client();
  if (!sql || !envelopeId) return;
  await sql`
    INSERT INTO hire_events
      (envelope_id, candidate_id, application_id, candidate_name, candidate_email, start_date, status)
    VALUES
      (${envelopeId}, ${candidateId || null}, ${applicationId || null}, ${candidateName || null},
       ${candidateEmail || null}, ${startDate || null}, 'sent')
    ON CONFLICT (envelope_id) DO UPDATE SET
      candidate_id    = COALESCE(EXCLUDED.candidate_id, hire_events.candidate_id),
      application_id  = COALESCE(EXCLUDED.application_id, hire_events.application_id),
      candidate_name  = COALESCE(EXCLUDED.candidate_name, hire_events.candidate_name),
      candidate_email = COALESCE(EXCLUDED.candidate_email, hire_events.candidate_email),
      start_date      = COALESCE(EXCLUDED.start_date, hire_events.start_date),
      updated_at      = now()
  `;
}

async function getEvent(envelopeId) {
  const sql = client();
  if (!sql) return null;
  const rows = await sql`SELECT * FROM hire_events WHERE envelope_id = ${envelopeId}`;
  return rows[0] || null;
}

// Atomically claim an envelope for processing. Returns true if THIS caller won
// the claim, false if it was already completed or is being processed. This is
// the idempotency gate against DocuSign Connect's retries.
async function claimForProcessing(envelopeId, fields) {
  const sql = client();
  if (!sql) throw new Error('DATABASE_URL is required for the hire webhook');
  const rows = await sql`
    INSERT INTO hire_events
      (envelope_id, candidate_id, application_id, candidate_name, candidate_email, start_date, status, dry_run, raw)
    VALUES
      (${envelopeId}, ${fields.candidateId || null}, ${fields.applicationId || null},
       ${fields.candidateName || null}, ${fields.candidateEmail || null}, ${fields.startDate || null},
       'processing', ${fields.dryRun}, ${fields.raw ? JSON.stringify(fields.raw) : null})
    ON CONFLICT (envelope_id) DO UPDATE SET
      status          = 'processing',
      dry_run         = ${fields.dryRun},
      candidate_id    = COALESCE(hire_events.candidate_id, EXCLUDED.candidate_id),
      application_id  = COALESCE(hire_events.application_id, EXCLUDED.application_id),
      candidate_name  = COALESCE(hire_events.candidate_name, EXCLUDED.candidate_name),
      candidate_email = COALESCE(hire_events.candidate_email, EXCLUDED.candidate_email),
      start_date      = COALESCE(hire_events.start_date, EXCLUDED.start_date),
      updated_at      = now()
    WHERE hire_events.status IN ('sent', 'failed')
    RETURNING envelope_id
  `;
  return rows.length > 0;
}

async function updateEvent(envelopeId, patch) {
  const sql = client();
  if (!sql) return;
  // neon()'s client only supports tagged-template calls (no .query(text, params)),
  // so every column is COALESCE'd against its own current value — passing a field
  // as undefined/null simply leaves that column unchanged. Single fixed statement,
  // safe and parameterized.
  await sql`
    UPDATE hire_events SET
      status               = COALESCE(${patch.status ?? null}, status),
      checkr_candidate_id   = COALESCE(${patch.checkrCandidateId ?? null}, checkr_candidate_id),
      checkr_invitation_id  = COALESCE(${patch.checkrInvitationId ?? null}, checkr_invitation_id),
      checkr_sent_at        = COALESCE(${patch.checkrSentAt ?? null}, checkr_sent_at),
      gh_attachment_id      = COALESCE(${patch.ghAttachmentId ?? null}, gh_attachment_id),
      gh_attachment_at      = COALESCE(${patch.ghAttachmentAt ?? null}, gh_attachment_at),
      gh_hired_at           = COALESCE(${patch.ghHiredAt ?? null}, gh_hired_at),
      gh_offer_id           = COALESCE(${patch.ghOfferId ?? null}, gh_offer_id),
      last_error            = COALESCE(${patch.lastError ?? null}, last_error),
      updated_at            = now()
    WHERE envelope_id = ${envelopeId}
  `;
}

// Logged whenever a recruiter generates an offer letter for a linked
// Greenhouse candidate — before any DocuSign envelope exists. Best-effort.
async function logOfferDraft({ candidateId, applicationId, candidateName, candidateEmail, startDate }) {
  const sql = client();
  if (!sql || !candidateId) return;
  await sql`
    INSERT INTO offer_drafts (candidate_id, application_id, candidate_name, candidate_email, start_date)
    VALUES (${candidateId}, ${applicationId || null}, ${candidateName || null}, ${candidateEmail || null}, ${startDate || null})
  `;
}

// Fallback lookups for envelopes with no custom fields (manually created in
// DocuSign instead of via "Send to DocuSign"). Most recent draft wins.
async function findDraftByEmail(email) {
  const sql = client();
  if (!sql || !email) return null;
  const rows = await sql`
    SELECT * FROM offer_drafts WHERE lower(candidate_email) = lower(${email})
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] || null;
}

async function findDraftByName(name) {
  const sql = client();
  if (!sql || !name) return null;
  const rows = await sql`
    SELECT * FROM offer_drafts WHERE lower(candidate_name) = lower(${name})
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] || null;
}

module.exports = {
  dbEnabled,
  recordEnvelopeSent,
  getEvent,
  claimForProcessing,
  updateEvent,
  logOfferDraft,
  findDraftByEmail,
  findDraftByName,
};
