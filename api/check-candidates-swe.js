const { processJob } = require('../lib/screening-engine');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  try {
    const results = await processJob('swe');
    return res.json({ success: true, job: 'Software Engineer', ...results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
