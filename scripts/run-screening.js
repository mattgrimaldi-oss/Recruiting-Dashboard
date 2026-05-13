const { processJob } = require('../lib/screening-engine');
const CRITERIA = require('../criteria.json');

async function main() {
  const roleArg = (process.argv[2] || '').trim();
  const timeArg  = (process.argv[3] || '').trim();
  const timeWindowHoursOverride = timeArg ? Number(timeArg) : null;

  // All roles defined in criteria.json (excluding the config key)
  const allRoles = Object.keys(CRITERIA).filter(k => k !== 'config');

  // Determine which role(s) to run:
  //   - Manual run with specific role arg → just that role
  //   - No arg but cronRole set in config  → just that role (cron single-role mode)
  //   - Otherwise                          → all roles
  let roles;
  if (roleArg && roleArg !== 'all') {
    roles = [roleArg];
  } else if (!roleArg && CRITERIA.config?.cronRole) {
    roles = [CRITERIA.config.cronRole];
  } else {
    roles = allRoles;
  }

  const timeWindow = timeWindowHoursOverride || CRITERIA.config?.timeWindowHours || 48;

  console.log(`\n🔍 Candidate screening started — ${new Date().toISOString()}`);
  console.log(`   Roles: ${roles.join(', ')}`);
  console.log(`   Time window: ${timeWindow}h\n`);

  for (const role of roles) {
    console.log(`\n--- Processing: ${role.toUpperCase()} ---`);
    try {
      const results = await processJob(role, timeWindowHoursOverride);
      console.log(`✅ Checked: ${results.checked}`);
      console.log(`⏭️  Skipped (work auth): ${results.skipped_work_auth}`);
      console.log(`⏭️  Skipped (no resume): ${results.skipped_no_resume}`);
      console.log(`🚨 Notified: ${results.notified}`);
      if (results.candidates?.length) {
        results.candidates.forEach(c => console.log(`   ${c.passes ? '✅' : '❌'} ${c.name}`));
      }
      if (results.message) console.log(`   ${results.message}`);
    } catch (err) {
      console.error(`❌ Error processing ${role}: ${err.message}`);
    }
  }

  console.log('\n✅ Screening complete.\n');
}

main();
