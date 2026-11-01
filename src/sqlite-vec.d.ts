declare module "sqlite-vec" {
  /** Absolute path to the platform's loadable SQLite extension. */
  export function getLoadablePath(): string;
  /** Load the extension into a better-sqlite3 database instance. */
  export function load(db: unknown): void;
}
