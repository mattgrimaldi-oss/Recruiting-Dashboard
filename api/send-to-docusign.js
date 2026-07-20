// Shared DocuSign auth/HTTPS helpers live in lib/docusign so the hire webhook
// and this send endpoint use the exact same JWT flow.
const docusign = require('../lib/docusign');
const db = require('../lib/db');
const { makeJwt, httpsRequest, httpsPost, httpsPut, CUSTOM_FIELDS } = docusign;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {

  const {
    pdfBase64, candidateName, candidateEmail, sender,
    // Greenhouse ids from the dashboard's name->id index (index.html). Stashed on
    // the envelope as custom fields so the hire webhook can map back to the
    // candidate deterministically. Optional so offer-sending still works if a
    // candidate isn't matched, but the hire automation needs them.
    candidateId, applicationId, startDate,
  } = req.body || {};
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

  // Auth as selected sender for envelope creation + sender view
  const senderJwt = makeJwt(DOCUSIGN_INTEGRATION_KEY, selectedUserId, authHost, privateKeyPem);
  const senderTokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${senderJwt}`;
  const senderTokenResp = await httpsPost(authHost, '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, senderTokenBody);
  if (senderTokenResp.status !== 200) {
    console.error('DocuSign sender auth failed:', JSON.stringify(senderTokenResp.body));
    return res.status(502).json({ error: 'DocuSign authentication failed', detail: senderTokenResp.body });
  }
  const accessToken = senderTokenResp.body.access_token;

  // Auth as admin (Matt) for template fetch — DS Sender accounts lack template read permissions
  let adminToken = accessToken;
  if (selectedUserId !== DOCUSIGN_USER_ID) {
    const adminJwt = makeJwt(DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, authHost, privateKeyPem);
    const adminTokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${adminJwt}`;
    const adminTokenResp = await httpsPost(authHost, '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, adminTokenBody);
    if (adminTokenResp.status === 200) adminToken = adminTokenResp.body.access_token;
  }

  const apiBase = `/restapi/v2.1/accounts/${DOCUSIGN_ACCOUNT_ID}`;
  const authHeader = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Fetch tab positions from the template using admin token
  const tmplResp = await httpsRequest('GET', DOCUSIGN_BASE_URL,
    `${apiBase}/templates/${DOCUSIGN_TEMPLATE_ID}/recipients?include_tabs=true`,
    { Authorization: `Bearer ${adminToken}` });

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

  // Stamp the Greenhouse mapping onto the envelope so envelope-completed can
  // resolve the candidate without name/email matching. show: false keeps them
  // out of the signer-facing UI.
  const textCustomFields = [
    [CUSTOM_FIELDS.candidateId, candidateId],
    [CUSTOM_FIELDS.applicationId, applicationId],
    [CUSTOM_FIELDS.candidateEmail, candidateEmail],
    [CUSTOM_FIELDS.startDate, startDate],
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => ({ name, value: String(value), show: 'false', required: 'false' }));

  const envelopeResp = await httpsPost(DOCUSIGN_BASE_URL, `${apiBase}/envelopes`, authHeader, {
    ...(textCustomFields.length ? { customFields: { textCustomFields } } : {}),
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

  // Best-effort: record the envelope -> Greenhouse mapping so the hire webhook
  // can resolve it even if the custom fields are ever missing. Never blocks the
  // offer send if the DB is unavailable.
  try {
    await db.recordEnvelopeSent({
      envelopeId: eid, candidateId, applicationId,
      candidateName, candidateEmail, startDate,
    });
  } catch (e) {
    console.warn('Could not record envelope mapping (non-fatal):', e.message);
  }

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
