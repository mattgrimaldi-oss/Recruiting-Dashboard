const https = require('https');
const crypto = require('crypto');


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

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const req = https.request(
      { hostname, path, method, headers: { ...headers, ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
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

const httpsPost = (hostname, path, headers, body) => httpsRequest('POST', hostname, path, headers, body);
const httpsPut  = (hostname, path, headers, body) => httpsRequest('PUT',  hostname, path, headers, body);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {

  const { pdfBase64, candidateName, candidateEmail, sender } = req.body || {};
  if (!pdfBase64 || !candidateEmail || !candidateName) {
    return res.status(400).json({ error: 'Missing required fields: pdfBase64, candidateName, candidateEmail' });
  }

  const {
    DOCUSIGN_ACCOUNT_ID,
    DOCUSIGN_INTEGRATION_KEY,
    DOCUSIGN_USER_ID,
    DOCUSIGN_USER_ID_CONNOR,
    DOCUSIGN_USER_ID_MEGHAN,
    DOCUSIGN_PRIVATE_KEY,
    DOCUSIGN_BASE_URL = 'demo.docusign.net',
    DOCUSIGN_TEMPLATE_ID,
    BRIAN_EMAIL = 'brian@flipcx.com',
  } = process.env;

  if (!DOCUSIGN_ACCOUNT_ID || !DOCUSIGN_INTEGRATION_KEY || !DOCUSIGN_USER_ID || !DOCUSIGN_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Missing DocuSign environment variables' });
  }

  const userIdMap = { matt: DOCUSIGN_USER_ID, connor: DOCUSIGN_USER_ID_CONNOR, meghan: DOCUSIGN_USER_ID_MEGHAN };
  const selectedUserId = userIdMap[sender] || DOCUSIGN_USER_ID;

  const isSandbox = DOCUSIGN_BASE_URL.includes('demo');
  const authHost = isSandbox ? 'account-d.docusign.com' : 'account.docusign.com';
  const privateKeyPem = DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, '\n');

  // Exchange JWT for access token
  const jwt = makeJwt(DOCUSIGN_INTEGRATION_KEY, selectedUserId, authHost, privateKeyPem);
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  const tokenResp = await httpsPost(authHost, '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, tokenBody);
  if (tokenResp.status !== 200) {
    console.error('DocuSign auth failed:', JSON.stringify(tokenResp.body));
    return res.status(502).json({ error: 'DocuSign authentication failed', detail: tokenResp.body });
  }
  const accessToken = tokenResp.body.access_token;

  const apiBase = `/restapi/v2.1/accounts/${DOCUSIGN_ACCOUNT_ID}`;
  const authHeader = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Fetch tab positions from the template so placement is always correct
  const tmplResp = await httpsRequest('GET', DOCUSIGN_BASE_URL,
    `${apiBase}/templates/${DOCUSIGN_TEMPLATE_ID}/recipients?include_tabs=true`,
    { Authorization: `Bearer ${accessToken}` });

  if (tmplResp.status !== 200) {
    console.error('Template fetch error:', JSON.stringify(tmplResp.body));
    return res.status(502).json({ error: 'Failed to fetch template tabs', detail: tmplResp.body });
  }

  const tmplSigners = tmplResp.body.signers || [];
  const candidateSigner = tmplSigners.find(s => s.roleName === 'candidate' || s.name === 'candidate');
  const ceoSigner = tmplSigners.find(s => s.roleName === 'ceo' || s.name === 'ceo');

  // Strip template-specific fields, remap recipientId/documentId for plain envelope
  function remapTabs(tabs, recipientId) {
    if (!tabs) return {};
    const remapped = {};
    for (const [tabType, tabList] of Object.entries(tabs)) {
      remapped[tabType] = tabList.map(({ pageNumber, xPosition, yPosition, optional }) => ({
        documentId: '1', recipientId, pageNumber, xPosition, yPosition, optional,
      }));
    }
    return remapped;
  }

  const candidateTabs = remapTabs(candidateSigner?.tabs, '1');
  const ceoTabs = remapTabs(ceoSigner?.tabs, '2');

  const envelopeResp = await httpsPost(DOCUSIGN_BASE_URL, `${apiBase}/envelopes`, authHeader, {
    emailSubject: `Action Required: Offer Letter for ${candidateName} — Flip CX`,
    documents: [{
      documentBase64: pdfBase64,
      name: `${candidateName} Offer Letter`,
      fileExtension: 'pdf',
      documentId: '1',
    }],
    recipients: {
      signers: [
        {
          email: candidateEmail,
          name: candidateName,
          recipientId: '1',
          routingOrder: '1',
          tabs: candidateTabs,
        },
        {
          email: BRIAN_EMAIL,
          name: 'Brian Schiff',
          recipientId: '2',
          routingOrder: '2',
          tabs: ceoTabs,
        },
      ],
    },
    status: 'created',
  });

  if (envelopeResp.status !== 201) {
    console.error('DocuSign envelope error:', JSON.stringify(envelopeResp.body));
    return res.status(502).json({ error: 'Envelope creation failed', detail: envelopeResp.body });
  }

  const eid = envelopeResp.body.envelopeId;

  // Get sender view URL so user can review and send from DocuSign
  const viewResp = await httpsPost(DOCUSIGN_BASE_URL, `${apiBase}/envelopes/${eid}/views/sender`, authHeader, {
    returnUrl: 'https://recruiting-dashboard-woad.vercel.app',
  });

  if (viewResp.status !== 201) {
    console.error('Sender view error:', JSON.stringify(viewResp.body));
    return res.status(502).json({ error: 'Failed to get sender view', detail: viewResp.body });
  }

  return res.status(200).json({ envelopeId: eid, senderViewUrl: viewResp.body.url });
  } catch (err) {
    console.error('Unhandled error:', err.message, err.stack);
    return res.status(502).json({ error: 'Server error', detail: err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '10mb' } } };
