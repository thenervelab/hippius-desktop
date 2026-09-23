/**
 * The two `indexedDB` entry points the store lifecycle uses, over a set of
 * database names: `databases()` lists them, `deleteDatabase()` removes one
 * through the request/event shape the real API has. jsdom and node ship no
 * IndexedDB at all, and the code under test only ever names and deletes
 * databases (the SDK owns their contents), so a name set is the whole model.
 */
export interface FakeIndexedDB {
  names: Set<string>;
  deleted: string[];
  databases: () => Promise<Array<{ name?: string; version?: number }>>;
  deleteDatabase: (name: string) => IDBOpenDBRequest;
}

export function makeFakeIndexedDB(initial: Iterable<string> = [], options: { listable?: boolean } = {}): FakeIndexedDB {
  const names = new Set(initial);
  const deleted: string[] = [];
  const fake: FakeIndexedDB = {
    names,
    deleted,
    databases: async () => [...names].map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      const req = {} as IDBOpenDBRequest & { onsuccess: ((event: Event) => void) | null };
      // Async like the real thing: the caller attaches handlers after the
      // call returns. A microtask, not a timer, so tests under fake timers
      // are not stalled by it.
      queueMicrotask(() => {
        names.delete(name);
        deleted.push(name);
        req.onsuccess?.(new Event("success"));
      });
      return req;
    },
  };
  if (options.listable === false) {
    // Firefox before 126: no `databases()` at all.
    delete (fake as Partial<FakeIndexedDB>).databases;
  }
  return fake;
}
