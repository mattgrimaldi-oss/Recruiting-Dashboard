// Greenhouse Harvest (v1) helpers used by the hire webhook.
//
// Writes (attachment upload, mark hired) require the On-Behalf-Of header — a
// Greenhouse user id, for audit. All writes honor dryRun: when true they log the
// exact intended call and return without touching Greenhouse, so we can validate
// end-to-end against a real signed envelope before flipping HIRE_AUTOMATION_DRY_RUN
// to false. The handoff flagged 403s on individual-candidate calls, so failures
// return rich detail for debugging.

const https = require('https');

const V1_HOST = 'harvest.greenhouse.io';

function ghConfig() {
  return {
    // Reuses the existing v1 Harvest key already configured for the dashboard's
    // other Greenhouse calls (check-candidates, screening, etc.) rather than
    // requiring a duplicate secret.
    apiKey: process.env.GREENHOUSE_API_KEY_V1,
    onBehalfOf: process.env.GREENHOUSE_ON_BEHALF_OF,
    attachmentType: process.env.GH_ATTACHMENT_TYPE || 'signed_offer_letter',
    // Close reason applied to the opening this hire fills. Defaults to the
    // account's "Hire - New Headcount" reason (id read from existing openings,
    // since the /close_reasons endpoint is 403 for this key). Overridable via env.
    closeReasonId: process.env.GH_CLOSE_REASON_ID || '4011609008',
  };
}

function request(method, path, { apiKey, onBehalfOf, body } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(onBehalfOf ? { 'On-Behalf-Of': String(onBehalfOf) } : {}),
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
    };
    const req = https.request({ hostname: V1_HOST, path: `/v1${path}`, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function fail(msg, resp) {
  const err = new Error(msg);
  err.status = resp.status;
  err.detail = resp.body;
  return err;
}

// GET /v1/applications/{id}/offers/current_offer — used to pull a start date if
// one exists. Returns null if there's no offer (common here: offers are sent via
// DocuSign, not Greenhouse's native flow).
async function getCurrentOffer(applicationId) {
  const cfg = ghConfig();
  if (!applicationId) return null;
  const resp = await request('GET', `/applications/${applicationId}/offers/current_offer`, { apiKey: cfg.apiKey });
  if (resp.status === 404) return null;
  if (resp.status >= 300) throw fail('Greenhouse current_offer fetch failed', resp);
  return resp.body;
}

// POST /v1/candidates/{id}/attachments — upload the signed offer PDF.
async function uploadAttachment({ candidateId, filename, pdfBuffer, dryRun }) {
  const cfg = ghConfig();
  if (dryRun) {
    console.log('[dry-run] Greenhouse: would upload attachment', {
      candidateId, filename, type: cfg.attachmentType, bytes: pdfBuffer ? pdfBuffer.length : 0,
    });
    return { attachmentId: null, dryRun: true };
  }
  if (!candidateId) throw new Error('uploadAttachment requires candidateId');
  const resp = await request('POST', `/candidates/${candidateId}/attachments`, {
    apiKey: cfg.apiKey,
    onBehalfOf: cfg.onBehalfOf,
    body: {
      filename,
      type: cfg.attachmentType,
      content: pdfBuffer.toString('base64'),
      content_type: 'application/pdf',
    },
  });
  if (resp.status >= 300) throw fail('Greenhouse attachment upload failed', resp);
  return { attachmentId: resp.body.id || resp.body.filename || 'uploaded', dryRun: false };
}

// Resolve which open opening this hire should fill. The job object embeds its
// openings inline, so we read the application's job and pick the first opening
// still marked "open". Returns null if none found — Greenhouse then auto-selects
// one, matching the API's documented fallback. Read-only, safe in dry-run.
async function resolveOpeningId(applicationId, apiKey) {
  const appResp = await request('GET', `/applications/${applicationId}`, { apiKey });
  if (appResp.status >= 300) throw fail('Greenhouse application fetch failed', appResp);
  const jobId = appResp.body.jobs && appResp.body.jobs[0] && appResp.body.jobs[0].id;
  if (!jobId) return null;
  const jobResp = await request('GET', `/jobs/${jobId}`, { apiKey });
  if (jobResp.status >= 300) throw fail('Greenhouse job fetch failed', jobResp);
  const open = (jobResp.body.openings || []).find(o => o.status === 'open');
  return open ? open.id : null;
}

// POST /v1/applications/{id}/hire — mark the application hired.
// Fills: start_date (from offer form / current_offer), opening_id (the open
// opening on the job), close_reason_id (Hire - New Headcount by default).
// Office is set at the job level, not passable here. "Keep job open" and
// "make candidate private" have no Harvest API support — see notes in the
// module footer; those remain manual.
async function markHired({ applicationId, startDate, dryRun }) {
  const cfg = ghConfig();
  if (!applicationId) throw new Error('markHired requires applicationId');

  const openingId = await resolveOpeningId(applicationId, cfg.apiKey);
  const closeReasonId = cfg.closeReasonId ? Number(cfg.closeReasonId) : null;

  const body = {};
  if (startDate) body.start_date = startDate;
  if (openingId) body.opening_id = openingId;
  if (closeReasonId) body.close_reason_id = closeReasonId;

  if (dryRun) {
    console.log('[dry-run] Greenhouse: would mark application hired', { applicationId, body });
    return { hired: false, dryRun: true, openingId, closeReasonId };
  }
  const resp = await request('POST', `/applications/${applicationId}/hire`, {
    apiKey: cfg.apiKey,
    onBehalfOf: cfg.onBehalfOf,
    body,
  });
  if (resp.status >= 300) throw fail('Greenhouse mark-hired failed', resp);
  return { hired: true, dryRun: false, openingId, offerId: resp.body.offer && resp.body.offer.id };
}

module.exports = { getCurrentOffer, uploadAttachment, markHired, resolveOpeningId, ghConfig };
