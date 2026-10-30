import { AA_TEXT, contrastRatio, oklchToHex } from '../contrast';
import { PALETTES, THEME_NAMES, type DirectionId, type Mode } from '../palettes';
import { Candidate, DirectionScope, EachDirection, ShowcaseShell } from '../ui';

// Literal class names so Tailwind can see them.
const ROLES = [
  { role: 'base-100', label: 'Base 100 (cards)', swatch: 'bg-base-100 text-base-content' },
  { role: 'base-200', label: 'Base 200 (page)', swatch: 'bg-base-200 text-base-content' },
  { role: 'base-300', label: 'Base 300 (borders)', swatch: 'bg-base-300 text-base-content' },
  { role: 'primary', label: 'Primary', swatch: 'bg-primary text-primary-content' },
  { role: 'secondary', label: 'Secondary', swatch: 'bg-secondary text-secondary-content' },
  { role: 'accent', label: 'Accent', swatch: 'bg-accent text-accent-content' },
  { role: 'neutral', label: 'Neutral', swatch: 'bg-neutral text-neutral-content' },
  { role: 'info', label: 'Info', swatch: 'bg-info text-info-content' },
  { role: 'success', label: 'Success', swatch: 'bg-success text-success-content' },
  { role: 'warning', label: 'Warning', swatch: 'bg-warning text-warning-content' },
  { role: 'error', label: 'Error', swatch: 'bg-error text-error-content' },
] as const;

type PairRow = { label: string; ratio: number };

function pairsFor(direction: DirectionId, mode: Mode): PairRow[] {
  const p = PALETTES[direction][mode];
  const rows: PairRow[] = [
    { label: 'Body text on base 100', ratio: contrastRatio(p['base-content'], p['base-100']) },
    { label: 'Body text on base 200', ratio: contrastRatio(p['base-content'], p['base-200']) },
    { label: 'Body text on base 300', ratio: contrastRatio(p['base-content'], p['base-300']) },
    {
      label: 'Secondary text (70%) on base 100',
      ratio: contrastRatio(p['base-content'], p['base-100'], 0.7),
    },
    {
      label: 'Secondary text (70%) on base 300',
      ratio: contrastRatio(p['base-content'], p['base-300'], 0.7),
    },
  ];
  for (const role of [
    'primary',
    'secondary',
    'accent',
    'neutral',
    'info',
    'success',
    'warning',
    'error',
  ] as const) {
    rows.push({
      label: `${role}-content on ${role}`,
      ratio: contrastRatio(p[`${role}-content`], p[role]),
    });
  }
  // accent and warning are background-only by the theme rules, so they are not tested as text.
  for (const role of ['primary', 'secondary', 'info', 'success', 'error'] as const) {
    rows.push({ label: `${role} text on base 100`, ratio: contrastRatio(p[role], p['base-100']) });
    rows.push({ label: `${role} text on base 300`, ratio: contrastRatio(p[role], p['base-300']) });
  }
  return rows;
}

function PaletteCandidate({
  direction,
  mode,
  id,
}: {
  direction: DirectionId;
  mode: Mode;
  id: string;
}) {
  const palette = PALETTES[direction][mode];
  const rows = pairsFor(direction, mode);
  const worst = Math.min(...rows.map((row) => row.ratio));
  return (
    <Candidate id={id} title={`${THEME_NAMES[direction][mode]} palette`}>
      <DirectionScope
        direction={direction}
        mode={mode}
        className="flex flex-col gap-4 rounded-box p-3"
      >
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {ROLES.map(({ role, label, swatch }) => (
            <li
              key={role}
              className={`flex min-h-24 flex-col justify-between rounded-field border border-base-300 p-2 text-sm ${swatch}`}
            >
              <span className="font-medium">{label}</span>
              <span className="sc-mono text-xs">{oklchToHex(palette[role])}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm">
          Lowest text contrast in this palette: <strong>{worst.toFixed(2)}:1</strong> (AA needs{' '}
          {AA_TEXT}:1).
        </p>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <caption className="sr-only">{`${id} contrast ratios`}</caption>
            <thead>
              <tr>
                <th scope="col">Text pair</th>
                <th scope="col">Ratio</th>
                <th scope="col">AA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="font-normal">
                    {row.label}
                  </th>
                  <td className="sc-mono">{row.ratio.toFixed(2)}:1</td>
                  <td>{row.ratio >= AA_TEXT ? 'Pass' : 'Fail'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DirectionScope>
    </Candidate>
  );
}

export function ColorsPage() {
  return (
    <ShowcaseShell title="Colours">
      <EachDirection
        render={(direction) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <PaletteCandidate direction={direction} mode="light" id={`${direction}-COL-1`} />
            <PaletteCandidate direction={direction} mode="dark" id={`${direction}-COL-2`} />
          </div>
        )}
      />
    </ShowcaseShell>
  );
}
