import { InjectedCrash } from "./errors.js";

/** Named points where tests can simulate abrupt process death. */
export const FAULT_POINTS = [
  "apply.before_remote",
  "apply.after_remote_success",
  "compensate.before_remote",
  "compensate.after_remote_success",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultContext {
  operation_id: string;
  compensation_id?: string;
}

type Hook = (ctx: FaultContext) => void | Promise<void>;

/**
 * Deterministic fault injection. The worker never catches InjectedCrash, so a throw here is the
 * in-process equivalent of the process dying at that exact point (the lease is left to expire).
 * Production code uses an injector with nothing armed, which does nothing.
 */
export class FaultInjector {
  private readonly armed = new Map<FaultPoint, number>();
  private readonly hooks = new Map<FaultPoint, Hook>();
  readonly fired: FaultPoint[] = [];

  /** Throw InjectedCrash the next `times` times execution reaches `point`. */
  crashAt(point: FaultPoint, times = 1): void {
    this.armed.set(point, times);
  }

  /** Run `hook` (e.g. plant an external edit) each time execution reaches `point`. */
  onPoint(point: FaultPoint, hook: Hook): void {
    this.hooks.set(point, hook);
  }

  clear(): void {
    this.armed.clear();
    this.hooks.clear();
  }

  async at(point: FaultPoint, ctx: FaultContext): Promise<void> {
    const hook = this.hooks.get(point);
    if (hook) await hook(ctx);
    const left = this.armed.get(point) ?? 0;
    if (left > 0) {
      this.armed.set(point, left - 1);
      this.fired.push(point);
      throw new InjectedCrash(point);
    }
  }
}
