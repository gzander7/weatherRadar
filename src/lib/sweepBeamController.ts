export interface SweepTick {
  angleDegrees: number;
  elapsedMs: number;
}

export class SweepBeamController {
  private rotationPeriodMs: number;
  private frameHandle: number | null = null;
  private startTimestamp: number | null = null;
  private tickListener: ((tick: SweepTick) => void) | null = null;

  constructor(rotationPeriodMs: number) {
    this.rotationPeriodMs = rotationPeriodMs;
  }

  setRotationPeriodMs(rotationPeriodMs: number) {
    this.rotationPeriodMs = Math.max(500, rotationPeriodMs);
  }

  reset() {
    this.startTimestamp = null;
  }

  start(listener: (tick: SweepTick) => void) {
    this.tickListener = listener;

    if (this.frameHandle !== null) {
      return;
    }

    const step = (timestamp: number) => {
      if (this.startTimestamp === null) {
        this.startTimestamp = timestamp;
      }

      const elapsedMs = timestamp - this.startTimestamp;
      const cycleMs = ((elapsedMs % this.rotationPeriodMs) + this.rotationPeriodMs) % this.rotationPeriodMs;
      const angleDegrees = (cycleMs / this.rotationPeriodMs) * 360;

      this.tickListener?.({
        angleDegrees,
        elapsedMs
      });

      this.frameHandle = window.requestAnimationFrame(step);
    };

    this.frameHandle = window.requestAnimationFrame(step);
  }

  stop() {
    if (this.frameHandle !== null) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }
}
