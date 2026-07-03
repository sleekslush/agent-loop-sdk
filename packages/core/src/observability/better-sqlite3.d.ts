// Optional dependency declaration so the SQLite adapter compiles even when
// better-sqlite3 is not installed. Consumers who choose the sqlite store must
// install it at runtime.
declare module "better-sqlite3" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Database: new (...args: any[]) => any;
  export default Database;
}
