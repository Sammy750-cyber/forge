import type { Clock } from '../ports/index.js';

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
