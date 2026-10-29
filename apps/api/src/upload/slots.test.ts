import { describe, expect, it } from 'vitest';
import { createUploadSlots } from './slots.ts';

describe('createUploadSlots', () => {
  it('caps uploads per user and per process', () => {
    const slots = createUploadSlots({ perUser: 2, total: 3 });
    const a1 = slots.tryAcquire('a');
    const a2 = slots.tryAcquire('a');
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(slots.tryAcquire('a')).toBeUndefined();
    const b1 = slots.tryAcquire('b');
    expect(b1).toBeDefined();
    // Process-wide limit reached, although b holds only one.
    expect(slots.tryAcquire('b')).toBeUndefined();
    expect(slots.inFlight()).toEqual({ total: 3, users: 2 });
  });

  it('frees a slot once per release, however often it is called', () => {
    const slots = createUploadSlots({ perUser: 1, total: 2 });
    const release = slots.tryAcquire('a');
    if (release === undefined) throw new Error('no slot');
    release();
    release();
    expect(slots.inFlight()).toEqual({ total: 0, users: 0 });
    const again = slots.tryAcquire('a');
    expect(again).toBeDefined();
    expect(slots.tryAcquire('b')).toBeDefined();
    // A double release of the first slot did not free a second one.
    expect(slots.tryAcquire('c')).toBeUndefined();
  });
});
