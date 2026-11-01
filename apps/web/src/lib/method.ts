/** The sections of `/method` in page order: the § number is the position plus one. */
export const METHOD_ANCHORS = ['inputs', 'sources', 'example', 'tests', 'limits'] as const;

export type MethodAnchor = (typeof METHOD_ANCHORS)[number];
