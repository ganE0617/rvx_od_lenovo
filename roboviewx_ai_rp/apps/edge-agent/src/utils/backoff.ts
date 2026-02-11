/**
 * Exponential backoff helper
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private baseDelayMs: number,
    private maxDelayMs: number,
    private maxRetries: number
  ) {}

  public next(): number | null {
    if (this.attempt >= this.maxRetries) {
      return null;
    }

    const delay = Math.min(
      this.baseDelayMs * Math.pow(2, this.attempt),
      this.maxDelayMs
    );

    this.attempt++;
    return delay;
  }

  public reset(): void {
    this.attempt = 0;
  }

  public getAttempt(): number {
    return this.attempt;
  }
}
