import type { Translator } from './i18n';

export interface StepLabel {
  /** What the run is doing, in the agent's words. */
  label: string;
  /** One line on what that step produces. */
  description: string;
}

/**
 * The steps of the `listing-launch` service (definitions/services) that have a plain-language
 * label in the `steps` messages. A coverage test reads the definition, so a new step cannot ship
 * without a label.
 */
const KNOWN_STEP_IDS = [
  'intake',
  'fact_extraction',
  'vision_inventory',
  'reconciliation',
  'creative',
  'qa_cards',
  'staging',
  'integrity',
  'verification',
  'export',
] as const;

type KnownStepId = (typeof KNOWN_STEP_IDS)[number];

function isKnownStep(stepId: string): stepId is KnownStepId {
  return (KNOWN_STEP_IDS as readonly string[]).includes(stepId);
}

const humanizeId = (stepId: string): string => {
  const words = stepId.replaceAll(/[_-]+/g, ' ').trim();
  return words === '' ? stepId : words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label of a step; an unknown ID falls back to a humanised ID with no description. */
export function stepLabel(t: Translator<'steps'>, stepId: string): StepLabel {
  if (!isKnownStep(stepId)) return { label: humanizeId(stepId), description: '' };
  return { label: t(`${stepId}.label`), description: t(`${stepId}.description`) };
}

export function knownStepIds(): string[] {
  return [...KNOWN_STEP_IDS];
}
