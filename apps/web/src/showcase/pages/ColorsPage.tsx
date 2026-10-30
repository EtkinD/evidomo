import { AA_TEXT, contrastRatio, oklchToHex } from '../contrast';
import { PALETTE, SHAPE, THEME_NAMES, type Mode } from '../palettes';
import { SampleScope } from '../samples/parts';
import { Candidate, ShowcaseShell } from '../ui';

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

function pairsFor(mode: Mode): PairRow[] {
  const p = PALETTE[mode];
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

function PaletteSpecimen({ mode, id }: { mode: Mode; id: string }) {
  const palette = PALETTE[mode];
  const rows = pairsFor(mode);
  const worst = Math.min(...rows.map((row) => row.ratio));
  return (
    <Candidate id={id} title={`${THEME_NAMES[mode]} palette`}>
      <SampleScope mode={mode} className="flex flex-col gap-4 rounded-box p-3">
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {ROLES.map(({ role, label, swatch }) => (
            <li
              key={role}
              className={`flex min-h-24 flex-col justify-between rounded-field border border-base-300 p-2 text-sm ${swatch}`}
            >
              <span className="font-medium">{label}</span>
              <span className="font-mono text-xs">{oklchToHex(palette[role])}</span>
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
                  <td className="font-mono">{row.ratio.toFixed(2)}:1</td>
                  <td>{row.ratio >= AA_TEXT ? 'Pass' : 'Fail'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SampleScope>
    </Candidate>
  );
}

export function ColorsPage() {
  return (
    <ShowcaseShell title="Colours">
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <PaletteSpecimen mode="light" id="H-COL-1" />
          <PaletteSpecimen mode="dark" id="H-COL-2" />
        </div>
        <Candidate id="H-SHAPE-1" title="Shape and density tokens (both themes)">
          <ul className="grid gap-2 sm:grid-cols-3">
            {[
              { token: '--radius-selector', value: SHAPE.radiusSelector, cls: 'rounded-selector' },
              { token: '--radius-field', value: SHAPE.radiusField, cls: 'rounded-field' },
              { token: '--radius-box', value: SHAPE.radiusBox, cls: 'rounded-box' },
            ].map((shape) => (
              <li
                key={shape.token}
                className={`flex flex-col gap-1 border border-base-300 bg-base-200 p-3 ${shape.cls}`}
              >
                <code className="font-mono text-sm">{shape.token}</code>
                <span className="font-mono text-sm text-base-content/70">{shape.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-base-content/70">
            Border 1px, <code className="font-mono">--depth</code> 0 (flat, no depth shadows),{' '}
            <code className="font-mono">--noise</code> 0.
          </p>
        </Candidate>
      </div>
    </ShowcaseShell>
  );
}
