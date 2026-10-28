import type {
  ClaimAuditCategory,
  ClaimAuditRule,
  MarketProfile,
  PhrasingCategory,
} from '@evidomo/shared';
import { copyPhrasingCategories } from '../creative/prompt.ts';

// The verification rubric (docs/architecture.md §5 Verification): claim support, the phrasing
// categories, and the area-basis rule, built from the market profile, never hardcoded per
// market. The rule texts are part of the verifier prompt: changing one changes the request hash
// (re-record the P3-06 fixtures and bump VERIFICATION_PROMPT_VERSION).

const CLAIM_SUPPORT_RULE =
  'Every statement must be justified by the facts the segment cites, read literally; facts the segment does not cite do not support it. ' +
  'Unsupported: a feature, quality, condition, location detail, or comparison that no cited fact states; a cited fact strengthened, generalized, or reinterpreted; ' +
  'a number used for a different quantity than its fact measures; a count, size, or condition taken from a presence fact (it only shows that something is there); ' +
  'legal or commercial status words that no cited fact states (included in the sale or price, freehold, own land, ownership, permit, available, new, guaranteed). ' +
  'A false or "no" value supports only its plain negation ("no ground lease"), not a different positive status. ' +
  'Supported: a plain restatement or translation of a cited fact, and neutral connecting words.';

const PHRASING_RULE_TEXT: Readonly<Record<PhrasingCategory, string>> = {
  unverifiable_superlative:
    'No superlatives, absolutes, or rankings the facts cannot prove ("best", "most sought-after", "unique", "perfect", "stunning", "ideal", "rare", "never", "always", "one of the finest"). Factual adjectives a cited fact states are fine.',
  investment_promise:
    'No promises or predictions about value, price development, returns, rent, demand, or the future ("will rise in value", "a safe investment", "sure to sell", "guaranteed").',
  exclusionary:
    'No wording that addresses, prefers, or excludes buyers by family status, age, gender, origin, religion, disability, or a similar personal characteristic ("perfect for young families", "ideal for seniors", "suits a professional couple"). Describing the property and its surroundings neutrally is fine.',
};

function areaBasisRule(market: MarketProfile): string | null {
  const bases = new Map(market.area_bases.map((basis) => [basis.id, basis.label]));
  const areas = market.facts.flatMap((fact) =>
    fact.type === 'area'
      ? [`"${fact.key}" (${fact.label}) is measured as ${bases.get(fact.basis) ?? fact.basis}`]
      : [],
  );
  if (areas.length === 0) return null;
  return (
    `Area figures in this market: ${areas.join('; ')}. ` +
    'A figure presented as one of these areas (for example as living area or living space, or as the plot) must cite that fact. ' +
    'Any other area figure (a room, a balcony, a storage room, a gross or unspecified area) must say what it measures and must never be presented as, or added up into, one of these areas.'
  );
}

/**
 * The rubric for one market, in a fixed order: claim support, the phrasing categories the copy
 * prompt also forbids (superlatives and promises always, then the profile's `flagged_phrasing`),
 * and the area-basis rule when the profile has area facts. The verifier may flag only these
 * categories (the output schema's enum and the code check both enforce it).
 */
export function buildVerificationRubric(market: MarketProfile): ClaimAuditRule[] {
  const rules: ClaimAuditRule[] = [{ category: 'claim_support', rule: CLAIM_SUPPORT_RULE }];
  for (const category of copyPhrasingCategories(market)) {
    rules.push({ category, rule: PHRASING_RULE_TEXT[category] });
  }
  const area = areaBasisRule(market);
  if (area !== null) rules.push({ category: 'area_basis', rule: area });
  return rules;
}

export function rubricCategories(rubric: readonly ClaimAuditRule[]): ClaimAuditCategory[] {
  return rubric.map((rule) => rule.category);
}
