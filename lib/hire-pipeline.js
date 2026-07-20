// Orchestrates the three post-signing actions for one envelope:
//   1. Send the Checkr background-check invitation.
//   2. Upload the signed offer PDF to the Greenhouse candidate.
//   3. Mark the Greenhouse application hired.
//
// Each step is guarded by what's already recorded on the hire_events row, so a
// retry resumes rather than repeats. Steps are independent: a failure in one is
// recorded and re-thrown after best-effort completion of the earlier ones, so a
// later retry can pick up where it left off. Everything respects dryRun.

const docusign = require('./docusign');
const checkr = require('./checkr');
const greenhouse = require('./greenhouse');
const db = require('./db');

function splitName(full) {
  if (!full) return { firstName: undefined, lastName: undefined };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// event: the current hire_events row (has candidate_id, application_id, etc.)
// Returns a summary; throws if any step ultimately failed (after recording it).
async function runPipeline(event, { dryRun }) {
  const envelopeId = event.envelope_id;
  const results = { checkr: 'skipped', attachment: 'skipped', hired: 'skipped' };
  let firstError = null;

  // ── 1. Checkr invitation ──
  if (!event.checkr_invitation_id && !event.checkr_sent_at) {
    try {
      const { firstName, lastName } = splitName(event.candidate_name);
      const out = await checkr.sendInvitation({
        email: event.candidate_email,
        firstName, lastName,
        existingCandidateId: event.checkr_candidate_id || undefined,
        dryRun,
      });
      await db.updateEvent(envelopeId, {
        checkrCandidateId: out.candidateId,
        checkrInvitationId: out.invitationId,
        checkrSentAt: new Date().toISOString(),
      });
      results.checkr = out.dryRun ? 'dry-run' : 'sent';
    } catch (err) {
      firstError = firstError || err;
      results.checkr = `error: ${err.message}`;
      await db.updateEvent(envelopeId, { lastError: `checkr: ${err.message}` });
    }
  } else {
    results.checkr = 'already-sent';
  }

  // ── 2. Upload signed PDF to Greenhouse ──
  if (!event.gh_attachment_at) {
    try {
      const accessToken = await docusign.getAccessToken();
      const pdf = await docusign.fetchCombinedDocument(envelopeId, accessToken);
      const filename = `${event.candidate_name || 'candidate'} - Signed Offer Letter.pdf`;
      const out = await greenhouse.uploadAttachment({
        candidateId: event.candidate_id,
        filename,
        pdfBuffer: pdf,
        dryRun,
      });
      await db.updateEvent(envelopeId, {
        ghAttachmentId: out.attachmentId,
        ghAttachmentAt: new Date().toISOString(),
      });
      results.attachment = out.dryRun ? 'dry-run' : 'uploaded';
    } catch (err) {
      firstError = firstError || err;
      results.attachment = `error: ${err.message}`;
      await db.updateEvent(envelopeId, { lastError: `attachment: ${err.message}` });
    }
  } else {
    results.attachment = 'already-uploaded';
  }

  // ── 3. Mark hired ──
  if (!event.gh_hired_at) {
    try {
      // Prefer the start date stashed on the envelope; else pull from a
      // Greenhouse offer if one happens to exist.
      let startDate = event.start_date || null;
      let offerId = null;
      if (!startDate && event.application_id) {
        const offer = await greenhouse.getCurrentOffer(event.application_id);
        if (offer) {
          offerId = offer.id || null;
          startDate = offer.starts_at || null;
        }
      }
      const out = await greenhouse.markHired({
        applicationId: event.application_id,
        startDate,
        dryRun,
      });
      await db.updateEvent(envelopeId, {
        ghHiredAt: new Date().toISOString(),
        ghOfferId: out.offerId || offerId || undefined,
      });
      results.hired = out.dryRun ? 'dry-run' : 'hired';
    } catch (err) {
      firstError = firstError || err;
      results.hired = `error: ${err.message}`;
      await db.updateEvent(envelopeId, { lastError: `hired: ${err.message}` });
    }
  } else {
    results.hired = 'already-hired';
  }

  const allOk = !firstError;
  await db.updateEvent(envelopeId, { status: allOk ? 'completed' : 'failed' });
  if (firstError) {
    const e = new Error(`hire pipeline incomplete for ${envelopeId}`);
    e.results = results;
    e.cause = firstError;
    throw e;
  }
  return results;
}

module.exports = { runPipeline, splitName };
