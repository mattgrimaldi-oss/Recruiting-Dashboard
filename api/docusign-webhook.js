// DocuSign Connect listener for the post-offer hire chain.
//
// Subscribe a DocuSign Connect config to the `envelope-completed` event (fires
// only when ALL recipients have signed) and point it at this endpoint. On each
// delivery we:
//   1. Verify the Connect HMAC signature over the raw body.
//   2. Claim the envelope for processing (idempotency gate).
//   3. Run the full pipeline synchronously, then respond: Checkr invite ->
//      upload PDF -> mark hired. This is a classic Node serverless function
//      (not Fluid Compute), so there's no reliable "ACK then background work"
//      pattern here — see the note in the handler below.
//
// Idempotency is keyed on envelopeId in the hire_events table, so Connect's
// retries are safe. All Greenhouse/Checkr writes honor HIRE_AUTOMATION_DRY_RUN
// (defaults to true).

const docusign = require('../lib/docusign');
const db = require('../lib/db');
const { runPipeline } = require('../lib/hire-pipeline');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Pull the text custom fields out of a Connect JSON payload as { name: value }.
function customFieldsFromPayload(payload) {
  const map = {};
  const cf = payload?.data?.envelopeSummary?.customFields || payload?.customFields;
  for (const f of (cf?.textCustomFields || [])) map[f.name] = f.value;
  for (const f of (cf?.listCustomFields || [])) map[f.name] = f.value;
  return map;
}

// Every signer's email + name, in routing order — email is core recipient
// data DocuSign always includes, not a custom field, so this is present even
// on envelopes created manually outside "Send to DocuSign".
function allSigners(summary) {
  return (summary.recipients?.signers || []).map(s => ({ email: s.email, name: s.name }));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read body' });
  }

  // 1. Verify HMAC over the exact bytes received.
  const sigHeaders = docusign.connectSignatureHeaders(req.headers);
  const ok = docusign.verifyConnectHmac(raw, sigHeaders, process.env.DOCUSIGN_CONNECT_HMAC_KEY);
  if (!ok) {
    console.warn('DocuSign webhook: HMAC verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = payload.event || payload.status;
  const summary = payload?.data?.envelopeSummary || {};
  const envelopeId = payload?.data?.envelopeId || summary.envelopeId || payload.envelopeId;
  const status = summary.status || payload.status;

  // Only act on completed envelopes; ACK everything else so Connect stops.
  const isCompleted = event === 'envelope-completed' || status === 'completed';
  if (!isCompleted) return res.status(200).json({ ignored: true, event, status });
  if (!envelopeId) return res.status(400).json({ error: 'No envelopeId in payload' });

  const CF = docusign.CUSTOM_FIELDS;
  const cf = customFieldsFromPayload(payload);
  let fields = {
    candidateId: cf[CF.candidateId],
    applicationId: cf[CF.applicationId],
    candidateEmail: cf[CF.candidateEmail],
    startDate: cf[CF.startDate],
    candidateName: (summary.recipients?.signers || []).find((s) => s.roleName === 'candidate')?.name
      || (summary.recipients?.signers || [])[0]?.name,
  };

  // Fallbacks for the Greenhouse ids: DB mapping recorded at send time, then a
  // live custom-fields fetch from the DocuSign API.
  try {
    if (!fields.candidateId || !fields.applicationId) {
      const existing = await db.getEvent(envelopeId);
      if (existing) {
        fields.candidateId = fields.candidateId || existing.candidate_id;
        fields.applicationId = fields.applicationId || existing.application_id;
        fields.candidateEmail = fields.candidateEmail || existing.candidate_email;
        fields.candidateName = fields.candidateName || existing.candidate_name;
        fields.startDate = fields.startDate || existing.start_date;
      }
    }
    if (!fields.candidateId || !fields.applicationId) {
      const token = await docusign.getAccessToken();
      const apiCf = await docusign.fetchEnvelopeCustomFields(envelopeId, token);
      fields.candidateId = fields.candidateId || apiCf[CF.candidateId];
      fields.applicationId = fields.applicationId || apiCf[CF.applicationId];
      fields.candidateEmail = fields.candidateEmail || apiCf[CF.candidateEmail];
      fields.startDate = fields.startDate || apiCf[CF.startDate];
    }
    // Last resort: no custom fields at all — likely the recruiter downloaded
    // the signed PDF's source and created this envelope manually in DocuSign
    // rather than clicking "Send to DocuSign". Match against offer_drafts
    // (logged when the offer letter was generated) by signer email, then name.
    if (!fields.candidateId || !fields.applicationId) {
      const signers = allSigners(summary);
      let draft = null;
      for (const s of signers) {
        draft = s.email && await db.findDraftByEmail(s.email);
        if (draft) break;
      }
      if (!draft) {
        for (const s of signers) {
          draft = s.name && await db.findDraftByName(s.name);
          if (draft) break;
        }
      }
      if (draft) {
        fields.candidateId = fields.candidateId || draft.candidate_id;
        fields.applicationId = fields.applicationId || draft.application_id;
        fields.candidateEmail = fields.candidateEmail || draft.candidate_email;
        fields.candidateName = fields.candidateName || draft.candidate_name;
        fields.startDate = fields.startDate || draft.start_date;
      }
    }
  } catch (err) {
    console.error('DocuSign webhook: field resolution error', err.message);
  }

  const dryRun = process.env.HIRE_AUTOMATION_DRY_RUN !== 'false';

  // 2. Idempotency claim. If we didn't win the claim, it's already done or in
  // flight — ACK and stop.
  let claimed;
  try {
    claimed = await db.claimForProcessing(envelopeId, { ...fields, dryRun, raw: { event, status } });
  } catch (err) {
    console.error('DocuSign webhook: claim failed', err.message);
    // Can't dedup safely without the DB — return 500 so Connect retries later.
    return res.status(500).json({ error: 'Idempotency store unavailable' });
  }
  if (!claimed) {
    return res.status(200).json({ envelopeId, deduped: true });
  }

  // 3. Run the pipeline before responding. This is a classic Node serverless
  // function (not Fluid Compute), so there is no reliable way to ACK first and
  // keep working after the response is sent — @vercel/functions' waitUntil
  // does not extend execution here, and the container can freeze mid-work.
  // maxDuration is 60s (see vercel.json), well above what Checkr + Greenhouse +
  // the DocuSign document fetch take, so awaiting synchronously is safe.
  try {
    const fresh = await db.getEvent(envelopeId);
    const summaryOut = await runPipeline(fresh, { dryRun });
    console.log('Hire pipeline complete', { envelopeId, dryRun, ...summaryOut });
    return res.status(200).json({ envelopeId, dryRun, ...summaryOut });
  } catch (err) {
    console.error('Hire pipeline failed', { envelopeId, message: err.message, results: err.results, cause: err.cause?.detail });
    // Still 200: DocuSign Connect retries on non-2xx, and retrying wouldn't
    // help here (the failure is recorded per-step in hire_events; a stuck
    // 'processing' row would just block a legitimate retry from resuming).
    return res.status(200).json({ envelopeId, dryRun, error: err.message, results: err.results });
  }
};

// Raw body required for HMAC verification.
module.exports.config = { api: { bodyParser: false } };
