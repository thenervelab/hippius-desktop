import { atom } from "jotai";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";

/** The single shared Database instance (or null before init). */
export const hippiusDbAtom = atom<initSqlJsType.Database | null>(null);

/** Cached SQL.js module so we load wasm once. */
export const sqlJsModuleAtom = atom<any>(null);

/** In-flight init promise to dedupe concurrent init calls. */
export const dbInitPromiseAtom = atom<Promise<initSqlJsType.Database> | null>(
  null
);

/** Write queue (mutex) to serialize saves). */
export const dbWriteQueueAtom = atom<Promise<void>>(Promise.resolve());
