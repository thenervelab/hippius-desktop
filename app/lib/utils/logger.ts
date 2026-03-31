const isDev = process.env.NODE_ENV === "development";

export const logger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },
  warn: console.warn,
  error: console.error,
};
