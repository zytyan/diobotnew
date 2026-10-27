// Update handlers and durable jobs share this queue, so an old timeout cannot
// act on a user's new join while a Telegram request is in flight.
export class ChatQueue {
  private tails = new Map<number, Promise<void>>();
  async run<T>(chat: number, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(chat) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(chat, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(chat) === current) this.tails.delete(chat);
    }
  }
}
