import { REPLAY_SPEEDS } from '../../lib/demo';

/** Speed and restart. Neither writes anything: they only change how the stored events are played. */
export function ReplayControls({
  speed,
  onSpeedChange,
  onRestart,
  finished,
}: {
  speed: number;
  onSpeedChange: (speed: number) => void;
  onRestart: () => void;
  finished: boolean;
}) {
  return (
    <section
      aria-label="Replay controls"
      className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-box border border-base-300 bg-base-100 p-4"
    >
      <fieldset className="fieldset p-0">
        <legend className="fieldset-legend">Replay speed</legend>
        <div className="join">
          {REPLAY_SPEEDS.map((value) => (
            <input
              key={value}
              type="radio"
              name="replay-speed"
              className="btn join-item min-h-11"
              aria-label={`${value}×`}
              checked={speed === value}
              onChange={() => onSpeedChange(value)}
            />
          ))}
        </div>
      </fieldset>
      <button type="button" className="btn btn-outline min-h-11" onClick={onRestart}>
        Replay from the start
      </button>
      {finished && (
        <p role="status" className="text-sm text-base-content/70">
          The replay has finished.
        </p>
      )}
    </section>
  );
}
