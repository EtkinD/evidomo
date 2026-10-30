import {
  demoArtifactFileUrl,
  demoFactMaskUrl,
  demoMaterialFileUrl,
  demoTranscriptAudioUrl,
  runArtifactFileUrl,
  runFactMaskUrl,
  runMaterialFileUrl,
  runTranscriptAudioUrl,
} from '@evidomo/shared';

/**
 * Where the evidence files of one run live. The owner's screens and the public demo serve the
 * same files under different prefixes, so the evidence components take the builders from a
 * provider instead of importing one scheme.
 */
export interface EvidenceUrls {
  /** An original photo (`materials.id`). */
  materialFile: (materialId: string) => string;
  /** An image artifact: a staged image (`artifacts.id`). */
  artifactFile: (artifactId: string) => string;
  /** The voice memo a transcript was made from (`transcriptArtifactId` of a turn source). */
  transcriptAudio: (transcriptArtifactId: string) => string;
  /** The full-frame mask overlay of a `photo_region` fact. */
  factMask: (factId: string) => string;
}

export function runEvidenceUrls(runId: string): EvidenceUrls {
  return {
    materialFile: (materialId) => runMaterialFileUrl(runId, materialId),
    artifactFile: (artifactId) => runArtifactFileUrl(runId, artifactId),
    transcriptAudio: (artifactId) => runTranscriptAudioUrl(runId, artifactId),
    factMask: (factId) => runFactMaskUrl(runId, factId),
  };
}

export function demoEvidenceUrls(runId: string): EvidenceUrls {
  return {
    materialFile: (materialId) => demoMaterialFileUrl(runId, materialId),
    artifactFile: (artifactId) => demoArtifactFileUrl(runId, artifactId),
    transcriptAudio: (artifactId) => demoTranscriptAudioUrl(runId, artifactId),
    factMask: (factId) => demoFactMaskUrl(runId, factId),
  };
}
