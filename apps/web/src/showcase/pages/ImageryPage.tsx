import { AssetGrid, EachDirection, ShowcaseShell } from '../ui';

const SECTIONS = [
  { kind: 'hero', title: 'Heroes', label: 'Muse heroes' },
  { kind: 'interior', title: 'Interiors', label: 'Muse interiors' },
  { kind: 'illustration', title: 'Illustrations', label: 'Muse illustrations' },
] as const;

export function ImageryPage() {
  return (
    <ShowcaseShell title="Imagery">
      <EachDirection
        render={(direction) => (
          <>
            {SECTIONS.map((section) => (
              <div key={section.kind} className="flex flex-col gap-2">
                <h3 className="text-lg font-semibold">{section.title}</h3>
                <AssetGrid
                  direction={direction}
                  kinds={[section.kind]}
                  emptyLabel={section.label}
                />
              </div>
            ))}
          </>
        )}
      />
    </ShowcaseShell>
  );
}
