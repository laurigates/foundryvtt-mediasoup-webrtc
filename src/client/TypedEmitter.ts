/**
 * A minimal, DOM-free typed event emitter.
 *
 * Used by the transport core so it can report connection and media changes
 * without knowing who renders them. A listener that throws is logged and does
 * not stop the other listeners.
 */

export type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events extends object> {
  #listeners = new Map<keyof Events, Set<Listener<any>>>();

  /** Subscribe to an event. Returns a function that removes the listener. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Subscribe to the next occurrence of an event only. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /** Remove every listener, or every listener of one event. */
  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`MediaSoupVTT | listener for "${String(event)}" threw:`, error);
      }
    }
  }
}
