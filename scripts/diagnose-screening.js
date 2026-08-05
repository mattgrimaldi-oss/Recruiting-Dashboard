// One-off diagnostic: why are candidates being dropped before scoring?
// Run via the "Screening Diagnostic" workflow (workflow_dispatch).
const CRITERIA = require('../criteria.json');

const KEY = process.env.GREENHOUSE_API_KEY_V1;

async function ghAll(path) {
  const auth = Buffer.from(`${KEY}:`).toString('base64');
  const all = [];
  let url = `https://harvest.greenhouse.io/v1${path}`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`GH ${path}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (Array.isArray(data)) all.push(...data);
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return all;
}

async function gh(path) {
  const auth = Buffer.from(`${KEY}:`).toString('base64');
  const res = await fetch(`https://harvest.greenhouse.io/v1${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`GH ${path}: ${res.status}`);
  return res.json();
}

function isWorkAuthorized(application) {
  const answers = application.answers || [];
  const a = answers.find(x =>
    x.question?.toLowerCase().includes('authorized') ||
    x.question?.toLowerCase().includes('sponsorship') ||
    x.question?.toLowerCase().includes('work authorization')
  );
  if (!a) return true;
  return !!a.answer?.toLowerCase().includes('yes');
}

async function main() {
  const hours = Number(process.env.WINDOW_HOURS || CRITERIA.config?.timeWindowHours || 48);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const roles = Array.isArray(CRITERIA.config?.cronRole) && CRITERIA.config.cronRole.length
    ? CRITERIA.config.cronRole
    : Object.keys(CRITERIA).filter(k => k !== 'config' && k !== '_global');

  console.log(`\n=== SCREENING DIAGNOSTIC — window ${hours}h (since ${since}) ===\n`);

  for (const roleKey of roles) {
    const cfg = CRITERIA[roleKey];
    if (!cfg) { console.log(`!! unknown role ${roleKey}`); continue; }
    const jobIds = Array.isArray(cfg.jobIds) ? cfg.jobIds : [cfg.jobId];

    const apps = [];
    for (const jid of jobIds) {
      apps.push(...await ghAll(`/applications?job_id=${jid}&status=active&created_after=${since}&per_page=100`));
    }

    console.log(`\n######## ${cfg.jobName} (${roleKey}) — ${apps.length} active apps ########`);

    // 1. exact stage names present
    const stageCount = {};
    for (const a of apps) {
      const n = a.current_stage?.name ?? '(null)';
      stageCount[n] = (stageCount[n] || 0) + 1;
    }
    console.log(`  STAGE NAMES (exact, as Greenhouse reports them):`);
    for (const [n, c] of Object.entries(stageCount).sort((x, y) => y[1] - x[1])) {
      const matches = n.toLowerCase().includes('application review');
      console.log(`     ${String(c).padStart(3)}  "${n}"  ${matches ? '<-- PASSES filter' : '<-- FILTERED OUT'}`);
    }

    // 2. what the current filter yields
    const stagePass = apps.filter(a => a.current_stage?.name?.toLowerCase().includes('application review'));
    const authFail = stagePass.filter(a => !isWorkAuthorized(a));
    const eligible = stagePass.filter(a => isWorkAuthorized(a));
    console.log(`  FUNNEL: ${apps.length} fetched -> ${stagePass.length} in Application Review -> ${eligible.length} eligible (${authFail.length} work-auth rejected)`);

    // 3. resume format + greenhouse address for eligible candidates
    console.log(`  CANDIDATE DETAIL (eligible only):`);
    for (const a of eligible.slice(0, 25)) {
      let c;
      try { c = await gh(`/candidates/${a.candidate_id}`); } catch (e) { console.log(`     ! ${a.candidate_id}: ${e.message}`); continue; }
      const name = `${c.first_name} ${c.last_name}`;
      const resume = c.attachments?.find(x => x.type === 'resume');
      const fname = resume?.filename || '(no resume)';
      const ext = fname.includes('.') ? fname.split('.').pop().toLowerCase() : 'none';
      const addr = c.addresses?.[0]?.value || '(no address on file)';
      // rejection history: does this candidate have prior rejected apps?
      let rejected = '?';
      try {
        const capps = await gh(`/candidates/${a.candidate_id}/applications`).catch(() => null);
        if (Array.isArray(capps)) {
          rejected = capps.filter(x => x.status === 'rejected').length;
        } else if (Array.isArray(c.applications)) {
          rejected = c.applications.filter(x => x.status === 'rejected').length;
        }
      } catch {}
      const flag = ext !== 'pdf' && ext !== 'none' ? '  ⚠️ NON-PDF (parses to garbage)' : '';
      console.log(`     ${name.padEnd(24)} resume=.${ext.padEnd(5)} addr="${addr}"  prior_rejected=${rejected}${flag}`);
    }
  }
  console.log('\n=== END DIAGNOSTIC ===\n');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
