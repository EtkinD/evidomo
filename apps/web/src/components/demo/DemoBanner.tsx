/** On every demo page: what the visitor is looking at, said before anything else. */
export function DemoBanner() {
  return (
    <section aria-label="About this demo" className="alert alert-info alert-vertical items-start">
      <div className="flex flex-col gap-1">
        <p className="font-semibold">
          <span aria-hidden>ⓘ </span>Demo: a replay of a sample run
        </p>
        <p className="text-sm">
          The data is invented. Nothing here is live, nothing is sent to a model, and nothing you do
          is saved.
        </p>
      </div>
    </section>
  );
}
