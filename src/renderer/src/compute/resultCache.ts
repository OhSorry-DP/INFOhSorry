export interface ResultCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export interface ResultCacheValue<T> {
  value: T;
  estimatedBytes: number;
  ownerToken: string;
}

export interface ResultCache<T> {
  has(key: string): boolean;
  get(key: string): T | undefined;
  set(key: string, value: T, estimatedBytes: number, ownerToken: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  invalidateOwner(ownerToken: string): number;
  readonly count: number;
  readonly bytes: number;
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function createResultCache<T>({
  maxEntries = 64,
  maxBytes = 32 * 1024 * 1024,
}: ResultCacheOptions = {}): ResultCache<T> {
  if (!validNonNegativeInteger(maxEntries) || !validNonNegativeInteger(maxBytes)) {
    throw new RangeError('Cache limits must be non-negative finite integers');
  }

  const entries = new Map<string, ResultCacheValue<T>>();
  let bytes = 0;

  const remove = (key: string): boolean => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.estimatedBytes;
    return true;
  };

  return {
    has(key) {
      return entries.has(key);
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Map insertion order is the LRU order, oldest first.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, estimatedBytes, ownerToken) {
      if (!validNonNegativeInteger(estimatedBytes)) {
        throw new RangeError('estimatedBytes must be a non-negative finite integer');
      }
      if (typeof ownerToken !== 'string') throw new TypeError('ownerToken must be a string');

      remove(key);
      if (estimatedBytes > maxBytes || maxEntries === 0) return false;

      while (entries.size + 1 > maxEntries || bytes + estimatedBytes > maxBytes) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        remove(oldestKey);
      }

      entries.set(key, { value, estimatedBytes, ownerToken });
      bytes += estimatedBytes;
      return true;
    },
    delete: remove,
    clear() {
      entries.clear();
      bytes = 0;
    },
    invalidateOwner(ownerToken) {
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.ownerToken === ownerToken) {
          remove(key);
          removed += 1;
        }
      }
      return removed;
    },
    get count() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

export interface InFlightRegistry<T> {
  run(key: string, factory: () => T | PromiseLike<T>): Promise<T>;
  invalidate(key: string): boolean;
  clear(): void;
  readonly count: number;
}

export function createInFlightRegistry<T>(): InFlightRegistry<T> {
  const requests = new Map<string, Promise<T>>();
  const tokens = new Map<string, object>();

  return {
    run(key, factory) {
      const current = requests.get(key);
      if (current) return current;

      const token = {};
      tokens.set(key, token);
      // Promise.resolve().then also turns a synchronous factory throw into a rejection.
      const request = Promise.resolve().then(factory).finally(() => {
        if (tokens.get(key) === token) {
          tokens.delete(key);
          requests.delete(key);
        }
      });
      requests.set(key, request);
      return request;
    },
    invalidate(key) {
      const existed = requests.has(key);
      requests.delete(key);
      tokens.delete(key);
      return existed;
    },
    clear() {
      requests.clear();
      tokens.clear();
    },
    get count() {
      return requests.size;
    },
  };
}
