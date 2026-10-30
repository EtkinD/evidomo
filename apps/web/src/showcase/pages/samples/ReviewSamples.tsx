import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { ClaimAuditView } from '../../../components/ClaimAudit';
import { FactConflictsView } from '../../../components/FactConflicts';
import type { EvidenceUrls } from '../../../lib/evidence-urls';
import { segmentButtonId } from '../../../components/claim-audit/SegmentItem';
import { APPROVED_IMAGES, useAssetManifest } from '../../assets';
import { SampleApi } from '../../samples/sample-api';
import { RUN_ID, SAMPLE_CLIP_MS } from '../../samples/sample-data';
import { CLAIM } from '../../../__tests__/claim-audit-fixtures';
import { Sample, SampleShell, useApprovedImageUrl } from '../../samples/parts';

/** A soft two-note chime as a WAV data URL: the sample's stand-in for the recorded voice memo. */
function chimeDataUrl(): string {
  const rate = 8000;
  const samples = Math.round((rate * (SAMPLE_CLIP_MS.endMs + 400)) / 1000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const note = t < 1.3 ? 392 : 523;
    const local = t < 1.3 ? t : t - 1.3;
    const envelope = Math.exp(-3 * local) * Math.min(1, local * 80);
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin(2 * Math.PI * note * t) * envelope * 0.12 * 32767),
      true,
    );
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** A rounded rectangle over the middle of the photo, as the mask PNG the API would serve. */
const MASK_DATA_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1280" viewBox="0 0 1920 1280"><rect x="480" y="320" width="960" height="640" rx="48" fill="black"/></svg>',
)}`;

/** The evidence files of the sample run: one Muse photo, the chime, and the drawn mask. */
function useSampleUrls(): EvidenceUrls | null {
  const manifest = useAssetManifest();
  const photo = useApprovedImageUrl('floor');
  const chime = useMemo(() => (manifest.isPending ? null : chimeDataUrl()), [manifest.isPending]);
  return useMemo(
    () =>
      manifest.isPending || chime === null
        ? null
        : {
            materialFile: () => photo ?? '',
            transcriptAudio: () => chime,
            factMask: () => MASK_DATA_URL,
          },
    [manifest.isPending, photo, chime],
  );
}

function ReviewPage({ children }: { children: ReactNode }) {
  return (
    <div className="bg-base-200 px-4 py-8">
      <section className="card mx-auto max-w-6xl border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-6">{children}</div>
      </section>
    </div>
  );
}

function Loading() {
  return (
    <p role="status" className="px-4 py-8 text-base-content/70">
      Loading the sample…
    </p>
  );
}

function Gate1Sample() {
  const urls = useSampleUrls();
  if (urls === null) return <Loading />;
  return (
    <SampleApi gate="conflicts">
      <ReviewPage>
        <FactConflictsView runId={RUN_ID} urls={urls} />
      </ReviewPage>
    </SampleApi>
  );
}

/** Opens the evidence of the flagged sentence at desktop width, where it is a side panel. */
function useOpenFlaggedClaim(container: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!window.matchMedia('(min-width: 1024px)').matches) return;
    const timer = setInterval(() => {
      const button = container.current?.querySelector<HTMLElement>(
        `#${segmentButtonId(CLAIM.rooms)}`,
      );
      if (button === null || button === undefined) return;
      clearInterval(timer);
      button.click();
    }, 100);
    const stop = setTimeout(() => clearInterval(timer), 5_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [container]);
}

function Gate2Sample() {
  const urls = useSampleUrls();
  const container = useRef<HTMLDivElement>(null);
  useOpenFlaggedClaim(container);
  if (urls === null) return <Loading />;
  return (
    <SampleApi gate="audit">
      <div ref={container}>
        <ReviewPage>
          <ClaimAuditView runId={RUN_ID} urls={urls} />
        </ReviewPage>
      </div>
    </SampleApi>
  );
}

export function SampleReviewPage() {
  return (
    <SampleShell title="Sample: the two review gates">
      <div className="mx-auto w-full max-w-6xl px-4">
        <p className="rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
          These are the real gate screens (<code className="font-mono">FactConflictsView</code> and{' '}
          <code className="font-mono">ClaimAuditView</code>) on synthetic data. Decisions work but
          live only in this page view; Approve pack is not wired here. The photo is{' '}
          {APPROVED_IMAGES.floor.id}, the audio is a synthetic chime, and the highlighted region is
          a drawn mask.
        </p>
      </div>
      <Sample id="H-GATE1-1" title="Gate 1: one conflict with form, voice turn, and photo evidence">
        <Gate1Sample />
      </Sample>
      <Sample id="H-GATE2-1" title="Gate 2: one flagged claim with the evidence panel">
        <Gate2Sample />
      </Sample>
    </SampleShell>
  );
}
