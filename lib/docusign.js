// Shared DocuSign helpers: JWT auth, low-level HTTPS, Connect HMAC verification,
// combined-document fetch, and envelope custom-field reads.
//
// The JWT + HTTPS logic here is the same proven flow that api/send-to-docusign.js
// uses; it lives in one place so the webhook and the send endpoint agree.

const https = require('https');
const crypto = require('crypto');

// Names of the envelope text custom fields the dashboard stamps at offer-send
// time so the webhook can map envelope -> Greenhouse candidate deterministically.
// Shared by api/send-to-docusign.js (writes) and api/docusign-webhook.js (reads).
const CUSTOM_FIELDS = {
  candidateId: 'greenhouse_candidate_id',
  applicationId: 'greenhouse_application_id',
  candidateEmail: 'candidate_email',
  startDate: 'start_date',
};

function makeJwt(integrationKey, userId, audience, privateKeyPem) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: integrationKey,
    sub: userId,
    aud: audience,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKeyPem, 'base64url');
  return `${signingInput}.${signature}`;
}

// Generic HTTPS request. `raw: true` resolves the body as a Buffer (used for the
// combined PDF); otherwise it tries JSON and falls back to a string.
function httpsRequest(method, hostname, path, headers, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const req = https.request(
      { hostname, path, method, headers: { ...headers, ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (opts.raw) return resolve({ status: res.statusCode, body: buf, headers: res.headers });
          const text = buf.toString('utf8');
          try { resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, body: text, headers: res.headers }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const httpsPost = (hostname, path, headers, body) => httpsRequest('POST', hostname, path, headers, body);
const httpsPut  = (hostname, path, headers, body) => httpsRequest('PUT',  hostname, path, headers, body);

function envConfig() {
  const {
    DOCUSIGN_ACCOUNT_ID,
    DOCUSIGN_INTEGRATION_KEY,
    DOCUSIGN_USER_ID,
    DOCUSIGN_PRIVATE_KEY,
    DOCUSIGN_BASE_URL = 'demo.docusign.net',
  } = process.env;
  const isSandbox = DOCUSIGN_BASE_URL.includes('demo');
  return {
    accountId: DOCUSIGN_ACCOUNT_ID,
    integrationKey: DOCUSIGN_INTEGRATION_KEY,
    userId: DOCUSIGN_USER_ID,
    privateKeyPem: (DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    baseUrl: DOCUSIGN_BASE_URL,
    authHost: isSandbox ? 'account-d.docusign.com' : 'account.docusign.com',
  };
}

// Get an OAuth access token by impersonating a user (defaults to the configured
// admin user, which has access to envelopes created by the dashboard).
async function getAccessToken(userId) {
  const cfg = envConfig();
  const sub = userId || cfg.userId;
  const jwt = makeJwt(cfg.integrationKey, sub, cfg.authHost, cfg.privateKeyPem);
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const resp = await httpsPost(cfg.authHost, '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, tokenBody);
  if (resp.status !== 200) {
    const err = new Error('DocuSign authentication failed');
    err.detail = resp.body;
    throw err;
  }
  return resp.body.access_token;
}

// Verify a DocuSign Connect HMAC signature over the RAW request body.
// DocuSign sends base64(HMAC-SHA256(body, key)) in X-DocuSign-Signature-1
// (and -2 if a second key is configured). Returns true if any provided
// signature matches the key. rawBody must be the exact bytes received.
function verifyConnectHmac(rawBody, signatureHeaders, hmacKey) {
  if (!hmacKey) return false;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = crypto.createHmac('sha256', hmacKey).update(buf).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const candidates = Array.isArray(signatureHeaders) ? signatureHeaders : [signatureHeaders];
  return candidates.filter(Boolean).some((sig) => {
    const sigBuf = Buffer.from(String(sig));
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// Collect the X-DocuSign-Signature-* headers (there can be more than one).
function connectSignatureHeaders(headers) {
  const out = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^x-docusign-signature-\d+$/i.test(k)) out.push(v);
  }
  return out;
}

// Download the combined (flattened, all-signed) PDF for an envelope.
async function fetchCombinedDocument(envelopeId, accessToken) {
  const cfg = envConfig();
  const path = `/restapi/v2.1/accounts/${cfg.accountId}/envelopes/${envelopeId}/documents/combined`;
  const resp = await httpsRequest('GET', cfg.baseUrl, path, { Authorization: `Bearer ${accessToken}` }, null, { raw: true });
  if (resp.status !== 200) {
    const err = new Error('Failed to fetch combined document');
    err.detail = resp.body.toString('utf8').slice(0, 500);
    throw err;
  }
  return resp.body; // Buffer
}

// Read an envelope's text custom fields as a { name: value } map. Used as a
// fallback source for the Greenhouse ids if the webhook payload lacks them.
async function fetchEnvelopeCustomFields(envelopeId, accessToken) {
  const cfg = envConfig();
  const path = `/restapi/v2.1/accounts/${cfg.accountId}/envelopes/${envelopeId}/custom_fields`;
  const resp = await httpsRequest('GET', cfg.baseUrl, path, { Authorization: `Bearer ${accessToken}` });
  if (resp.status !== 200) return {};
  const map = {};
  for (const f of (resp.body.textCustomFields || [])) map[f.name] = f.value;
  for (const f of (resp.body.listCustomFields || [])) map[f.name] = f.value;
  return map;
}

module.exports = {
  CUSTOM_FIELDS,
  makeJwt,
  httpsRequest,
  httpsPost,
  httpsPut,
  envConfig,
  getAccessToken,
  verifyConnectHmac,
  connectSignatureHeaders,
  fetchCombinedDocument,
  fetchEnvelopeCustomFields,
};
