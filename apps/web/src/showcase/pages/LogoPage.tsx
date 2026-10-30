import { Lockup, logoCandidatesFor, type LogoCandidate } from '../logos';
import type { Mode } from '../palettes';
import { AssetGrid, Candidate, DirectionScope, EachDirection, ShowcaseShell } from '../ui';

const SIZES = [
  { px: 16, cls: 'size-4' },
  { px: 32, cls: 'size-8' },
  { px: 64, cls: 'size-16' },
] as const;

function OnMode({ candidate, mode }: { candidate: LogoCandidate; mode: Mode }) {
  return (
    <DirectionScope
      direction={candidate.direction}
      mode={mode}
      className="flex flex-col gap-4 rounded-box border border-base-300 p-4"
    >
      <span className="text-xs text-base-content/70">{mode === 'light' ? 'Light' : 'Dark'}</span>
      <Lockup candidate={candidate} />
      <div className="flex items-end gap-4 text-primary">
        {SIZES.map((size) => (
          <div key={size.px} className="flex flex-col items-center gap-1">
            <candidate.Mark className={size.cls} />
            <span className="sc-mono text-xs text-base-content/70">{size.px} px</span>
          </div>
        ))}
        <div className="flex flex-col items-center gap-1">
          <span className="flex size-16 items-center justify-center rounded-box bg-primary text-primary-content">
            <candidate.Mark className="size-10" />
          </span>
          <span className="sc-mono text-xs text-base-content/70">App icon</span>
        </div>
      </div>
    </DirectionScope>
  );
}

function SvgCandidate({ candidate }: { candidate: LogoCandidate }) {
  return (
    <Candidate id={candidate.id} title={candidate.title}>
      <div className="grid gap-3 sm:grid-cols-2">
        <OnMode candidate={candidate} mode="light" />
        <OnMode candidate={candidate} mode="dark" />
      </div>
    </Candidate>
  );
}

export function LogoPage() {
  return (
    <ShowcaseShell title="Logo">
      <EachDirection
        render={(direction) => (
          <>
            <h3 className="text-lg font-semibold">Muse concepts</h3>
            <AssetGrid
              direction={direction}
              kinds={['logo-concept']}
              emptyLabel="Muse logo concepts"
              columns="sm:grid-cols-2 lg:grid-cols-4"
            />
            <h3 className="text-lg font-semibold">SVG candidates</h3>
            <div className="grid gap-4">
              {logoCandidatesFor(direction).map((candidate) => (
                <SvgCandidate key={candidate.id} candidate={candidate} />
              ))}
            </div>
          </>
        )}
      />
    </ShowcaseShell>
  );
}
