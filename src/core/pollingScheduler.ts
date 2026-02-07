export type PollingTask = () => Promise<void>;

export class PollingScheduler {
  private readonly task: PollingTask;
  private readonly minimumIntervalSeconds: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failureCount = 0;
  private pollIntervalMs: number;

  public constructor(task: PollingTask, pollIntervalSeconds: number, minimumIntervalSeconds = 20) {
    this.task = task;
    this.minimumIntervalSeconds = minimumIntervalSeconds;
    this.pollIntervalMs = Math.max(this.minimumIntervalSeconds, pollIntervalSeconds) * 1000;
  }

  public setPollIntervalSeconds(seconds: number): void {
    this.pollIntervalMs = Math.max(this.minimumIntervalSeconds, seconds) * 1000;
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.schedule(0);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  public async triggerNow(): Promise<void> {
    try {
      await this.task();
      this.failureCount = 0;
      if (this.running) {
        this.schedule(this.pollIntervalMs);
      }
    } catch (error) {
      this.failureCount += 1;
      if (this.running) {
        const backoffMs = Math.min(5 * 60_000, this.pollIntervalMs * Math.pow(2, this.failureCount));
        const jitterMs = Math.floor(Math.random() * 400);
        this.schedule(backoffMs + jitterMs);
      }
      throw error;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      void this.runTask();
    }, delayMs);
  }

  private async runTask(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      await this.task();
      this.failureCount = 0;
      this.schedule(this.pollIntervalMs);
    } catch {
      this.failureCount += 1;
      const backoffMs = Math.min(5 * 60_000, this.pollIntervalMs * Math.pow(2, this.failureCount));
      const jitterMs = Math.floor(Math.random() * 400);
      this.schedule(backoffMs + jitterMs);
    }
  }
}
