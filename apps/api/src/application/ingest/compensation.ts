export type Compensation = () => Promise<void>;

export class CompensationStack {
  #compensations: Compensation[] = [];

  add(compensation: Compensation): void {
    this.#compensations.push(compensation);
  }

  clear(): void {
    this.#compensations = [];
  }

  async run(): Promise<void> {
    const compensations = this.#compensations.reverse();
    this.#compensations = [];

    for (const compensate of compensations) {
      try {
        await compensate();
      } catch {
        // Compensation is best-effort; preserve the original ingest failure.
      }
    }
  }
}
