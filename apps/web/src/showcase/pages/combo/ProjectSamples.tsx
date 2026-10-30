import { useId, useState } from 'react';
import { ComboImage, ComboShell, Sample, type ComboImageKey } from '../../combo/parts';

const PAGE = 'bg-base-200 px-4 py-8';
const CARD = 'card mx-auto w-full max-w-3xl border border-base-300 bg-base-100';

const THUMBS: readonly { image: ComboImageKey; position: string; label: string }[] = [
  { image: 'hero', position: 'object-left', label: 'Living room' },
  { image: 'floor', position: 'object-left', label: 'Kitchen floor' },
  { image: 'fireplace', position: 'object-left', label: 'Fireplace' },
  { image: 'hero', position: 'object-right', label: 'Window wall' },
  { image: 'floor', position: 'object-right', label: 'Hallway tiles' },
  { image: 'fireplace', position: 'object-right', label: 'Mantel' },
];

function PlayTurn() {
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-outline min-h-11"
      aria-pressed={playing}
      onClick={() => setPlaying((value) => !value)}
    >
      <span aria-hidden>{playing ? '■' : '▶'}</span>
      {playing ? 'Stop' : 'Play'}
      <span className="sr-only"> the voice walkthrough</span>
    </button>
  );
}

function Materials() {
  return (
    <div className={PAGE}>
      <section aria-labelledby="mat-title" className={CARD}>
        <div className="card-body gap-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id="mat-title" className="card-title text-2xl">
                Voorbeeldgracht 14
              </h2>
              <p className="text-sm text-base-content/70">
                Voorbeeldstad · Germany market · output in English
              </p>
            </div>
            <span className="badge badge-outline">Draft</span>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-lg font-semibold">Photos</h3>
            <p className="text-sm text-base-content/70">
              6 photos shown of 24 (3 to 30 needed). Synthetic thumbnails.
            </p>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Photo thumbnails">
              {THUMBS.map((thumb) => (
                <li key={thumb.label}>
                  <ComboImage
                    image={thumb.image}
                    aspect="aspect-square"
                    className="rounded-field"
                    position={thumb.position}
                    alt={thumb.label}
                  />
                </li>
              ))}
            </ul>
            <div>
              <button type="button" className="btn btn-outline min-h-11">
                Add photos
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t border-base-300 pt-4">
            <h3 className="text-lg font-semibold">Voice walkthrough</h3>
            <div className="flex flex-wrap items-center gap-3">
              <span className="badge badge-success">Uploaded</span>
              <span className="text-sm text-base-content/70">4:12 of 10:00 allowed</span>
              <PlayTurn />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function FactForm() {
  const area = useId();
  const rooms = useId();
  const label = useId();
  const labelError = useId();
  const heating = useId();
  return (
    <div className={PAGE}>
      <section aria-labelledby="facts-title" className={CARD}>
        <form className="card-body gap-5" noValidate onSubmit={(event) => event.preventDefault()}>
          <h2 id="facts-title" className="card-title text-2xl">
            Facts about the property
          </h2>
          <p className="text-sm text-base-content/70">
            Fields marked required must be filled in before a run. Everything you enter here is
            cited as a form field in the evidence.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="fieldset">
              <label htmlFor={area} className="fieldset-legend">
                Living area (m²)
              </label>
              <input
                id={area}
                className="input min-h-11 w-full"
                defaultValue="118"
                inputMode="decimal"
              />
              <p className="text-sm text-base-content/70">Measured as Wohnfläche.</p>
            </fieldset>
            <fieldset className="fieldset">
              <label htmlFor={rooms} className="fieldset-legend">
                Rooms
              </label>
              <input
                id={rooms}
                className="input min-h-11 w-full"
                defaultValue="5"
                inputMode="numeric"
              />
            </fieldset>
            <fieldset className="fieldset">
              <label htmlFor={label} className="fieldset-legend">
                Energy label
              </label>
              <input
                id={label}
                className="input input-error min-h-11 w-full"
                defaultValue="Z"
                aria-invalid
                aria-describedby={labelError}
              />
              <p id={labelError} className="text-sm text-error">
                <span aria-hidden>× </span>Use a label from A to G.
              </p>
            </fieldset>
            <fieldset className="fieldset">
              <label htmlFor={heating} className="fieldset-legend">
                Heating type
              </label>
              <select id={heating} className="select min-h-11 w-full" defaultValue="district">
                <option value="central">Central heating</option>
                <option value="district">District heating</option>
              </select>
            </fieldset>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-outline min-h-11">
              Save details
            </button>
            <span className="text-sm text-error">1 field needs attention.</span>
          </div>
        </form>
      </section>
    </div>
  );
}

function Readiness() {
  const codeId = useId();
  const [show, setShow] = useState(false);
  return (
    <div className={PAGE}>
      <section aria-labelledby="ready-title" className={CARD}>
        <div className="card-body gap-4">
          <h2 id="ready-title" className="card-title text-2xl">
            Start a run
          </h2>
          <p>All inputs are in place. You can start a run.</p>
          <fieldset className="fieldset">
            <label htmlFor={codeId} className="fieldset-legend">
              Access code
            </label>
            <div className="join w-full sm:max-w-sm">
              <input
                id={codeId}
                type={show ? 'text' : 'password'}
                className="input join-item min-h-11 w-full"
                defaultValue="sample-code"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn join-item min-h-11"
                aria-pressed={show}
                onClick={() => setShow((value) => !value)}
              >
                {show ? 'Hide' : 'Show'}
                <span className="sr-only"> access code</span>
              </button>
            </div>
            <p className="text-sm text-base-content/70">
              Live runs use paid model calls. If you were given a code, enter it; otherwise leave
              this empty.
            </p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary min-h-11">
              Start run
            </button>
            <span className="text-sm text-base-content/70">Estimated cost cap: $2.00 per run.</span>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ComboProjectPage() {
  return (
    <ComboShell title="Combination: project page">
      <Sample id="H-MAT-1" title="Materials summary: photo grid and voice walkthrough">
        <Materials />
      </Sample>
      <Sample id="H-FORM-1" title="Fact form excerpt with one field error">
        <FactForm />
      </Sample>
      <Sample id="H-READY-1" title="Readiness card with access code and Start run">
        <Readiness />
      </Sample>
    </ComboShell>
  );
}
