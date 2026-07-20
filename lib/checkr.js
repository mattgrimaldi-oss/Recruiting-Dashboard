// Checkr: create a candidate (if needed) and send a background-check invitation.
// Checkr emails the candidate the invitation link directly — we don't handle
// the report result here (that's phase 2 / check-gating).
//
// Auth is HTTP Basic with the API key as the username and an empty password.
// Default host is Checkr staging so nothing hits production until CHECKR_BASE_URL
// is set to api.checkr.com.

const https = require('https');

function checkrConfig() {
  return {
    apiKey: process.env.CHECKR_API_KEY,
    packageSlug: process.env.CHECKR_PACKAGE_SLUG,
    baseUrl: process.env.CHECKR_BASE_URL || 'api.checkr-staging.com',
    // Checkr requires a work location for many packages; default to a remote/US
    // node unless overridden. Format is a JSON array of { country, state? }.
    workLocations: process.env.CHECKR_WORK_LOCATIONS
      ? JSON.parse(process.env.CHECKR_WORK_LOCATIONS)
      : [{ country: 'US' }],
  };
}

function request(method, hostname, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const req = https.request(
      {
        hostname, path, method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Send a background check. Returns { candidateId, invitationId }.
// In dryRun mode, logs the intended calls and returns nulls without touching Checkr.
async function sendInvitation({ email, firstName, lastName, existingCandidateId, dryRun }) {
  const cfg = checkrConfig();
  if (!email) throw new Error('Checkr invitation requires a candidate email');

  if (dryRun) {
    console.log('[dry-run] Checkr: would create candidate + invitation', {
      email, package: cfg.packageSlug, host: cfg.baseUrl,
    });
    return { candidateId: null, invitationId: null, dryRun: true };
  }

  if (!cfg.apiKey) throw new Error('CHECKR_API_KEY is not set');
  if (!cfg.packageSlug) throw new Error('CHECKR_PACKAGE_SLUG is not set');

  let candidateId = existingCandidateId;
  if (!candidateId) {
    const candResp = await request('POST', cfg.baseUrl, '/v1/candidates', cfg.apiKey, {
      email,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
    });
    if (candResp.status >= 300) {
      const err = new Error('Checkr candidate creation failed');
      err.detail = candResp.body;
      throw err;
    }
    candidateId = candResp.body.id;
  }

  const invResp = await request('POST', cfg.baseUrl, '/v1/invitations', cfg.apiKey, {
    candidate_id: candidateId,
    package: cfg.packageSlug,
    work_locations: cfg.workLocations,
  });
  if (invResp.status >= 300) {
    const err = new Error('Checkr invitation failed');
    err.detail = invResp.body;
    throw err;
  }

  return { candidateId, invitationId: invResp.body.id, dryRun: false };
}

module.exports = { sendInvitation, checkrConfig };
