import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic, manually advanced UTC clock for tests and the demo. */
export class FixedClock implements Clock {
  private ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
    if (Number.isNaN(this.ms)) throw new TypeError(`FixedClock: invalid ISO timestamp ${iso}`);
  }
  now(): Date {
    return new Date(this.ms);
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function iso(date: Date): string {
  return date.toISOString();
}

export interface IdGenerator {
  next(): string;
}

export const randomIds: IdGenerator = { next: () => randomUUID() };

/** Deterministic UUID-shaped ids: `<prefix>-0000-4000-8000-<12 hex counter>`. */
export class SequentialIds implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = "00000000") {
    if (!/^[0-9a-f]{8}$/.test(prefix)) throw new TypeError("SequentialIds prefix must be 8 hex chars");
  }
  next(): string {
    this.n += 1;
    return `${this.prefix}-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}
