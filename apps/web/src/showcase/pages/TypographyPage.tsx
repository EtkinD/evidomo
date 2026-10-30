import { useMode } from '../mode';
import { SampleScope } from '../samples/parts';
import { Candidate, ShowcaseShell } from '../ui';

const SCALE = [
  { name: 'Display', cls: 'font-display text-5xl font-bold leading-tight' },
  { name: 'Heading 1', cls: 'font-display text-3xl font-bold' },
  { name: 'Heading 2', cls: 'font-display text-2xl font-semibold' },
  { name: 'Heading 3', cls: 'font-display text-xl font-semibold' },
  { name: 'Body', cls: 'text-base' },
  { name: 'Small', cls: 'text-sm' },
  { name: 'Caption', cls: 'text-xs' },
] as const;

const NL_SAMPLE = {
  title: 'Lichte hoekwoning met tuin op het zuiden',
  body: 'Deze ruime woning aan de Voorbeeldlaan 12 in Voorbeeldstad ligt in een rustige straat vlak bij het park. De woonkamer van 34 m² heeft openslaande deuren naar een zonnige achtertuin. De keuken is in 2021 vernieuwd. Energielabel B, vraagprijs € 489.000 k.k.',
  facts: 'Woonoppervlak 118 m² · Kamers 5 · Bouwjaar 1987',
};

const EN_SAMPLE = {
  title: 'Bright corner house with a south-facing garden',
  body: 'This spacious home at 12 Example Avenue, Example Town, sits on a quiet street next to the park. The 34 m² living room opens onto a sunny back garden. The kitchen was renewed in 2021. Energy label B, asking price € 489,000.',
  facts: 'Living area 118 m² · Rooms 5 · Built 1987',
};

export function TypographyPage() {
  const { mode } = useMode();
  return (
    <ShowcaseShell title="Typography">
      <div className="grid gap-4 lg:grid-cols-2">
        <Candidate id="H-TYPE-1" title="Newsreader / Source Sans 3 / system mono">
          <SampleScope mode={mode} className="flex flex-col gap-3 rounded-box p-3">
            {SCALE.map((row) => (
              <div key={row.name} className="flex flex-col">
                <span className="font-mono text-xs text-base-content/70">{row.name}</span>
                <span className={row.cls}>Every claim has evidence</span>
              </div>
            ))}
            <p>
              Evidomo turns a walkthrough, photos and a form into a listing pack in which every
              statement points to where it came from. The agent reviews, the evidence stays one tap
              away.
            </p>
            <p className="font-mono text-sm">
              run_7f3a91 · EV-0042 · 118 m² · € 489.000 · 00:42 – 00:51
            </p>
          </SampleScope>
        </Candidate>
        <Candidate id="H-TYPE-2" title="Listing text sample, Dutch and English (invented)">
          <SampleScope mode={mode} className="flex flex-col gap-4 rounded-box p-3">
            {[
              { lang: 'nl', label: 'Nederlands', sample: NL_SAMPLE },
              { lang: 'en', label: 'English', sample: EN_SAMPLE },
            ].map(({ lang, label, sample }) => (
              <article key={lang} lang={lang} className="flex flex-col gap-1">
                <span className="font-mono text-xs text-base-content/70">{label}</span>
                <h3 className="text-xl font-semibold">{sample.title}</h3>
                <p>{sample.body}</p>
                <p className="font-mono text-sm text-base-content/70">{sample.facts}</p>
              </article>
            ))}
          </SampleScope>
        </Candidate>
      </div>
    </ShowcaseShell>
  );
}
