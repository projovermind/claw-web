/**
 * Skill Injector — Lazy skill injection based on triggers and alwaysOn flags
 *
 * - alwaysOn=true (or no triggers configured): always inject full content
 * - triggers[] keyword match: inject full content
 * - no match: inject meta only (name + description header, empty content)
 */
import { logger } from './logger.js';

/**
 * Check if userMessage matches any trigger keyword for a skill
 */
function matchesTriggers(triggers, userMessage) {
  if (!triggers || triggers.length === 0) return false;
  const msg = userMessage.toLowerCase();
  return triggers.some(t => msg.includes(t.toLowerCase()));
}

/**
 * Lazy skill context builder.
 *
 * Returns a new skills array where:
 * - alwaysOn=true or no triggers configured (backward compat) → full content kept
 * - triggers[] matched → full content kept
 * - not matched → content cleared (meta-only: name + description header still rendered by runner)
 *
 * @param {Array} skills - resolved skill objects (from resolveSkills)
 * @param {string} userMessage - user's message
 * @returns {Array} - processed skills array
 */
export function buildSkillContext(skills, userMessage) {
  if (!skills || skills.length === 0) return skills;

  try {
    const msg = userMessage || '';
    let metaOnly = 0;

    const result = skills.map(sk => {
      // alwaysOn=true → always inject full content
      // alwaysOn not set AND no triggers → backward compat, treat as alwaysOn
      const isAlwaysOn =
        sk.alwaysOn === true ||
        (sk.alwaysOn == null && !(sk.triggers?.length > 0));

      if (isAlwaysOn) return sk;

      // trigger match → full content
      if (matchesTriggers(sk.triggers, msg)) return sk;

      // no match → meta only (clear content, runner still shows name+description header)
      metaOnly++;
      return { ...sk, content: '' };
    });

    if (metaOnly > 0) {
      logger.debug(
        { metaOnly, total: result.length },
        'skill-injector: lazy — some skills reduced to meta-only'
      );
    }
    return result;
  } catch (err) {
    logger.debug({ err: err.message }, 'skill-injector: failed (non-fatal), returning original skills');
    return skills;
  }
}
