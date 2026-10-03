export interface ResourceCacheOptions {
  force?: boolean;
}

export interface ResourceCacheStats {
  hit: number;
  miss: number;
  inFlightJoin: number;
  force: number;
}

export interface ResourceCache<T> {
  load(key: string, factory: () => Promise<T>, options?: ResourceCacheOptions): Promise<T>;
  invalidate(key: string): void;
  clear(): void;
  readonly stats?: ResourceCacheStats;
}

interface Entry<T> {
  generation: number;
  token: object;
  promise: Promise<T>;
}

/** Shares immutable completed values and pending work within this JavaScript realm. */
export function createResourceCache<T>(): ResourceCache<T> {
  const values = new Map<string, T>();
  const inFlight = new Map<string, Entry<T>>();
  const generations = new Map<string, number>();
  const counters: ResourceCacheStats = { hit: 0, miss: 0, inFlightJoin: 0, force: 0 };

  const bump = (key: string): number => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  };

  const load = (key: string, factory: () => Promise<T>, options: ResourceCacheOptions = {}): Promise<T> => {
    if (options.force) {
      counters.force++;
      const generation = bump(key);
      values.delete(key);
      return start(key, factory, generation);
    }
    if (values.has(key)) {
      counters.hit++;
      return Promise.resolve(values.get(key) as T);
    }
    const pending = inFlight.get(key);
    if (pending) {
      counters.inFlightJoin++;
      return pending.promise;
    }
    return start(key, factory, generations.get(key) ?? 0);
  };

  const start = (key: string, factory: () => Promise<T>, generation: number): Promise<T> => {
    generations.set(key, generation);
    counters.miss++;
    const token = {};
    const promise = Promise.resolve().then(factory).then((value) => {
      if (generations.get(key) === generation && inFlight.get(key)?.token === token) values.set(key, value);
      return value;
    }).finally(() => {
      if (inFlight.get(key)?.token === token) inFlight.delete(key);
    });
    inFlight.set(key, { generation, token, promise });
    return promise;
  };

  return {
    load,
    invalidate(key) {
      bump(key);
      values.delete(key);
      inFlight.delete(key);
    },
    clear() {
      for (const key of new Set([...values.keys(), ...inFlight.keys(), ...generations.keys()])) bump(key);
      values.clear();
      inFlight.clear();
    },
    get stats() { return { ...counters }; },
  };
}
