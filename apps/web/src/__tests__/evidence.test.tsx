import type { FactSource } from '@evidomo/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceInspector } from '../components/evidence/EvidenceInspector';
import { EvidenceProvider } from '../components/evidence/EvidenceProvider';
import { demoEvidenceUrls, runEvidenceUrls, type EvidenceUrls } from '../lib/evidence-urls';
import { formatTimestamp, regionInFrame } from '../lib/evidence';
import { MASK_ID, MATERIAL_ID, RUN_ID, TRANSCRIPT_ID } from './gate-fixtures';
import { IntlTest } from './test-utils';

const FACT_ID = '10000000-0000-4000-8000-000000000001';

/** Just enough of an `<audio>` element: the page holds one and drives it by these members. */
class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  /** Makes the next play() calls fail the way a browser does. */
  static playError: DOMException | null = null;
  srcAssignments: string[] = [];
  preload = '';
  currentTime = 0;
  paused = true;
  readyState = 0;
  duration = Number.NaN;
  error: object | null = null;
  play = vi.fn((): Promise<void> => {
    if (FakeAudio.playError !== null) return Promise.reject(FakeAudio.playError);
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  get src(): string {
    return this.srcAssignments.at(-1) ?? '';
  }
  set src(value: string) {
    this.srcAssignments.push(value);
    this.readyState = 0;
  }

  /** The browser has the file's metadata, so seeking works. */
  loadMetadata(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

/** Records the mask probes the photo component starts. */
class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

const turn = (
  turnIndex: number,
  startMs: number,
  endMs: number,
  quote: string,
  transcriptArtifactId: string = TRANSCRIPT_ID,
): FactSource => ({
  kind: 'transcript_turn',
  transcriptArtifactId,
  turnIndex,
  startMs,
  endMs,
  quote,
});

function renderEvidence(sources: FactSource[], urls: EvidenceUrls = runEvidenceUrls(RUN_ID)) {
  return render(
    <IntlTest>
      <EvidenceProvider urls={urls}>
        {sources.map((source, index) => (
          <EvidenceInspector
            key={index}
            factId={FACT_ID}
            source={source}
            valueText="92 m2"
            label="Living area"
          />
        ))}
      </EvidenceProvider>
    </IntlTest>,
  );
}

function photoSource(maskArtifactId?: string): FactSource {
  return {
    kind: 'photo_region',
    materialId: MATERIAL_ID,
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    ...(maskArtifactId === undefined ? {} : { maskArtifactId }),
  };
}

function loadPhoto(width: number, height: number): void {
  const photo = screen.getAllByRole('img', { name: 'Photo evidence for Living area' })[0];
  if (photo === undefined) throw new Error('No photo');
  Object.defineProperty(photo, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(photo, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(photo);
}

describe('transcript turn evidence', () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    FakeAudio.playError = null;
    vi.stubGlobal('Audio', FakeAudio);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const first = turn(3, 83_400, 91_600, 'about ninety-two square metres');
  const second = turn(7, 142_000, 150_250, 'ninety-eight with the extension');
  const OTHER_TRANSCRIPT = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';
  const elsewhere = turn(1, 5_000, 9_000, 'a different recording', OTHER_TRANSCRIPT);
  const play = (time: string) =>
    fireEvent.click(screen.getByRole('button', { name: `Play the turn at ${time}` }));
  const audio = (): FakeAudio => {
    const instance = FakeAudio.instances[0];
    if (instance === undefined) throw new Error('No audio element');
    return instance;
  };

  it('shows the quote and the timestamp', () => {
    renderEvidence([first]);

    expect(screen.getByText('“about ninety-two square metres”')).toBeDefined();
    expect(screen.getByText('Voice walkthrough, turn at 01:23')).toBeDefined();
    expect(screen.getByText('01:23 to 01:31')).toBeDefined();
  });

  it('calls play() inside the click (iOS Safari) and seeks to the turn once the metadata is there', () => {
    renderEvidence([first]);
    play('01:23');

    expect(audio().src).toBe(`/api/runs/${RUN_ID}/transcripts/${TRANSCRIPT_ID}/audio`);
    // The gesture is spent on play() itself; the seek follows when the file allows it.
    expect(audio().play).toHaveBeenCalledTimes(1);
    expect(audio().currentTime).toBe(0);

    act(() => {
      audio().loadMetadata();
    });
    expect(audio().currentTime).toBe(83.4);
    expect(screen.getByRole('button', { name: 'Stop the turn at 01:23' })).toBeDefined();
  });

  it('seeks at once when the recording is already loaded', () => {
    renderEvidence([first, second]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    play('02:22');

    expect(audio().currentTime).toBe(142);
    expect(audio().srcAssignments).toHaveLength(1);
  });

  it('stops at the end of the turn, by the interval or by timeupdate', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    act(() => {
      audio().currentTime = 90;
      vi.advanceTimersByTime(300);
    });
    expect(audio().pause).not.toHaveBeenCalled();

    act(() => {
      audio().currentTime = 91.65;
      vi.advanceTimersByTime(100);
    });
    expect(audio().pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();

    // A throttled interval must not let it run on: the media clock's own event ends it too.
    play('01:23');
    act(() => {
      audio().currentTime = 91.7;
      audio().dispatchEvent(new Event('timeupdate'));
    });
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
  });

  it('does not end a turn before the seek to its start happened', () => {
    renderEvidence([second]);
    play('02:22');

    // Still at position 0 of a file whose turn ends at 150 s: nothing to stop yet, and nothing
    // that looks like an end either way.
    act(() => {
      audio().dispatchEvent(new Event('timeupdate'));
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('button', { name: 'Stop the turn at 02:22' })).toBeDefined();
  });

  it('stops when the same button is pressed again', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop the turn at 01:23' }));

    expect(audio().pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
  });

  it('uses one audio element, so starting a turn stops the one that was playing', () => {
    renderEvidence([first, second]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    play('02:22');

    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio().pause).toHaveBeenCalled();
    expect(audio().play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Stop the turn at 02:22' })).toBeDefined();

    // The first turn's end no longer matters; only the second turn's end stops the audio.
    act(() => {
      audio().currentTime = 100;
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('button', { name: 'Stop the turn at 02:22' })).toBeDefined();
    act(() => {
      audio().currentTime = 150.3;
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('button', { name: 'Play the turn at 02:22' })).toBeDefined();
  });

  it('lets only the latest of two clips on different recordings seek when the metadata arrives', () => {
    renderEvidence([first, elsewhere]);
    play('01:23');
    play('00:05');

    expect(audio().srcAssignments).toEqual([
      `/api/runs/${RUN_ID}/transcripts/${TRANSCRIPT_ID}/audio`,
      `/api/runs/${RUN_ID}/transcripts/${OTHER_TRANSCRIPT}/audio`,
    ]);
    act(() => {
      audio().loadMetadata();
    });

    expect(audio().currentTime).toBe(5);
    expect(screen.getByRole('button', { name: 'Stop the turn at 00:05' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
  });

  it('cleans up when the page goes away', () => {
    const { unmount } = renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(audio().pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // No listener is left to act on later events.
    expect(() => {
      audio().dispatchEvent(new Event('timeupdate'));
      audio().dispatchEvent(new Event('ended'));
      audio().dispatchEvent(new Event('error'));
    }).not.toThrow();
  });

  it('says the audio is not available when the turn starts after the recording ends', () => {
    renderEvidence([first, second]);
    play('01:23');
    act(() => {
      // A one-second stand-in recording: both turns lie far beyond its end.
      audio().duration = 1;
      audio().loadMetadata();
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The audio for this part is not available');
    expect(audio().currentTime).toBe(0);
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    // The message belongs to one turn at a time: starting another clip clears the first's.
    play('02:22');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    act(() => {
      audio().duration = 600;
    });
    play('01:23');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not play an unavailable turn when the metadata is already loaded', () => {
    renderEvidence([first, second]);
    play('01:23');
    act(() => {
      audio().duration = 100;
      audio().loadMetadata();
    });
    // Playing now (in range); the second turn starts at 142 s, past the 100 s recording.
    expect(audio().play).toHaveBeenCalledTimes(1);

    play('02:22');

    expect(audio().play).toHaveBeenCalledTimes(1);
    expect(audio().paused).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('not available');
    expect(screen.getByRole('button', { name: 'Play the turn at 02:22' })).toBeDefined();
  });

  it('treats a start exactly at the end as unavailable, and an unknown duration as playable', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().duration = 83.4;
      audio().loadMetadata();
    });
    expect(screen.getByRole('alert').textContent).toContain('not available');
    expect(audio().paused).toBe(true);

    // A stream of unknown length reports Infinity: nothing says the turn is out of range.
    audio().duration = Number.POSITIVE_INFINITY;
    play('01:23');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(audio().currentTime).toBe(83.4);
  });

  it('still plays a turn that lies inside the recording', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().duration = 120;
      audio().loadMetadata();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(audio().currentTime).toBe(83.4);
    expect(screen.getByRole('button', { name: 'Stop the turn at 01:23' })).toBeDefined();
  });

  it('returns to Play when the recording ends', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    act(() => {
      audio().dispatchEvent(new Event('ended'));
    });

    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns to Play when something else pauses the audio', () => {
    renderEvidence([first]);
    play('01:23');
    act(() => {
      audio().loadMetadata();
    });

    act(() => {
      audio().paused = true;
      audio().dispatchEvent(new Event('pause'));
    });

    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
  });

  it('reports a play() the browser refuses', async () => {
    renderEvidence([first]);
    FakeAudio.playError = new DOMException('blocked', 'NotAllowedError');
    play('01:23');
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toContain('could not be played');
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();
  });

  it('ignores the rejection of a play() that a newer clip interrupted', async () => {
    renderEvidence([first]);
    FakeAudio.playError = new DOMException('interrupted', 'AbortError');
    play('01:23');
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop the turn at 01:23' })).toBeDefined();
  });

  it('says so when the recording cannot be loaded, and loads it again on the next try', () => {
    renderEvidence([first]);
    play('01:23');

    act(() => {
      audio().error = {};
      audio().dispatchEvent(new Event('error'));
    });

    expect(screen.getByRole('alert').textContent).toContain('could not be played');
    expect(screen.getByRole('button', { name: 'Play the turn at 01:23' })).toBeDefined();

    play('01:23');
    expect(audio().srcAssignments).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reloads a recording whose metadata never arrived', () => {
    renderEvidence([first]);
    play('01:23');
    fireEvent.click(screen.getByRole('button', { name: 'Stop the turn at 01:23' }));

    play('01:23');

    expect(audio().srcAssignments).toHaveLength(2);
  });

  it('formats timestamps as mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(59_999)).toBe('00:59');
    expect(formatTimestamp(3_725_000)).toBe('62:05');
  });
});

describe('form field and decision evidence', () => {
  it('shows the field label and the value as entered', () => {
    renderEvidence([{ kind: 'form', field: 'living_area' }]);

    expect(screen.getByText('Form field')).toBeDefined();
    expect(screen.getByText('Living area:').parentElement?.textContent).toBe('Living area: 92 m2');
  });

  it('attributes an operator-entered value to the operator', () => {
    renderEvidence([
      {
        kind: 'gate_decision',
        gate: 'fact_conflicts',
        conflictsArtifactId: MASK_ID,
        conflictId: 'K01',
      },
    ]);

    expect(screen.getByText('Your decision')).toBeDefined();
  });
});

describe('photo region evidence', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
  });

  it('lazy-loads the photo from the injected URLs', () => {
    renderEvidence([photoSource(MASK_ID)], demoEvidenceUrls(RUN_ID));

    const photo = screen.getByRole('img', { name: 'Photo evidence for Living area' });
    expect(photo.getAttribute('src')).toBe(
      `/api/demo/runs/${RUN_ID}/materials/${MATERIAL_ID}/file`,
    );
    expect(photo.getAttribute('loading')).toBe('lazy');
  });

  it('draws the mask overlay from the fact mask URL once the mask is known to load', () => {
    renderEvidence([photoSource(MASK_ID)]);
    expect(screen.queryByTestId('mask-overlay')).toBeNull();

    loadPhoto(1600, 1200);
    const probe = FakeImage.instances[0];
    expect(probe?.src).toBe(`/api/runs/${RUN_ID}/facts/${FACT_ID}/mask.png`);
    act(() => probe?.onload?.());

    const overlay = screen.getByTestId('mask-overlay');
    expect(
      overlay.style.maskImage || overlay.style.getPropertyValue('-webkit-mask-image'),
    ).toContain(`/api/runs/${RUN_ID}/facts/${FACT_ID}/mask.png`);
    expect(screen.queryByTestId('region-box')).toBeNull();
    expect(screen.getByText('The region is highlighted on the photo.')).toBeDefined();
  });

  it('draws the region box when the fact has no mask', () => {
    renderEvidence([photoSource()]);

    loadPhoto(1600, 1200);

    expect(FakeImage.instances).toHaveLength(0);
    expect(screen.queryByTestId('mask-overlay')).toBeNull();
    const box = screen.getByTestId('region-box');
    // A 4:3 photo fills the 4:3 frame, so the normalized region maps one to one.
    expect(box.style.left).toBe('25%');
    expect(box.style.top).toBe('25%');
    expect(box.style.width).toBe('50%');
    expect(box.style.height).toBe('50%');
    expect(screen.getByText('The region is outlined on the photo.')).toBeDefined();
  });

  it('falls back to the box when the mask cannot be loaded', () => {
    renderEvidence([photoSource(MASK_ID)]);

    loadPhoto(1600, 1200);
    act(() => FakeImage.instances[0]?.onerror?.());

    expect(screen.queryByTestId('mask-overlay')).toBeNull();
    expect(screen.getByTestId('region-box')).toBeDefined();
  });

  it('places the box inside the photo, not the frame, when the aspect ratios differ', () => {
    // A square photo in a 4:3 frame leaves bars left and right: 75% of the width is photo.
    expect(regionInFrame({ x: 0, y: 0, width: 1, height: 1 }, 1)).toEqual({
      left: 12.5,
      top: 0,
      width: 75,
      height: 100,
    });
    // A wide photo leaves bars above and below.
    const wide = regionInFrame({ x: 0, y: 0.5, width: 0.5, height: 0.5 }, 2);
    expect(wide.left).toBe(0);
    expect(wide.width).toBe(50);
    expect(wide.height).toBeCloseTo(33.333, 2);
    expect(wide.top).toBeCloseTo(50, 5);
  });

  it('opens a larger view in a modal and closes it', () => {
    renderEvidence([photoSource(MASK_ID)]);

    fireEvent.click(screen.getByRole('button', { name: 'Open larger photo for Living area' }));

    const dialog = screen.getByRole('dialog', { name: 'Photo evidence for Living area' });
    expect(dialog).toBeDefined();
    expect(screen.getAllByRole('img', { name: 'Photo evidence for Living area' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the photo cannot be loaded', () => {
    renderEvidence([photoSource(MASK_ID)]);

    fireEvent.error(screen.getByRole('img', { name: 'Photo evidence for Living area' }));

    expect(screen.getByText('The photo could not be loaded.')).toBeDefined();
  });
});
