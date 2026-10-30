export interface StepLabel {
  /** What the run is doing, in the agent's words. */
  label: string;
  /** One line on what that step produces. */
  description: string;
}

/**
 * Plain names for the steps of the `listing-launch` service (definitions/services). A coverage
 * test reads the definition, so a new step cannot ship without a label.
 */
const STEP_LABELS: Readonly<Record<string, StepLabel>> = {
  intake: {
    label: 'Reading the walkthrough',
    description: 'Turning your voice memo into a transcript, one speaker turn at a time.',
  },
  fact_extraction: {
    label: 'Picking out the facts',
    description:
      'Pulling facts from the transcript and your form, each tied to where it came from.',
  },
  vision_inventory: {
    label: 'Looking at the photos',
    description: 'Checking each photo for rooms, fittings, and condition.',
  },
  reconciliation: {
    label: 'Comparing the facts',
    description: 'Finding facts that disagree between the form, the voice, and the photos.',
  },
  creative: {
    label: 'Writing the listing',
    description: 'Drafting the portal text and the social caption from the confirmed facts.',
  },
  qa_cards: {
    label: 'Preparing buyer questions',
    description: 'Answering the questions buyers usually ask, from the same facts.',
  },
  staging: {
    label: 'Staging the photos',
    description: 'Producing furnished versions of empty rooms, always labelled as staged.',
  },
  integrity: {
    label: 'Checking the staged photos',
    description: 'Making sure staging changed no windows, doors, or other fixed elements.',
  },
  verification: {
    label: 'Checking every claim',
    description: 'Testing each sentence against the facts it cites.',
  },
  export: {
    label: 'Building the pack',
    description: 'Assembling the HTML pack, the portal fields, and the images.',
  },
};

const humanizeId = (stepId: string): string => {
  const words = stepId.replaceAll(/[_-]+/g, ' ').trim();
  return words === '' ? stepId : words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label of a step; an unknown ID falls back to a humanised ID with no description. */
export function stepLabel(stepId: string): StepLabel {
  return STEP_LABELS[stepId] ?? { label: humanizeId(stepId), description: '' };
}

export function knownStepIds(): string[] {
  return Object.keys(STEP_LABELS);
}
