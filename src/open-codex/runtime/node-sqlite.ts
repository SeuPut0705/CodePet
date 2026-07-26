import { DatabaseSync } from "node:sqlite";

export const constants = Object.freeze({
  SQLITE_OPEN_READONLY: 0x00000001,
  SQLITE_OPEN_READWRITE: 0x00000002,
  SQLITE_OPEN_CREATE: 0x00000004,
  SQLITE_OPEN_URI: 0x00000040,
});

type DatabaseFlags = number | { readonly?: boolean; readOnly?: boolean; create?: boolean };

function plainRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  return Object.fromEntries(Object.entries(row));
}

function databaseLocation(location: string): string | URL {
  return location.startsWith("file:") ? new URL(location) : location;
}

function databaseOptions(flags?: DatabaseFlags): { open: boolean; readOnly: boolean } {
  const readOnly = typeof flags === "number"
    ? (flags & constants.SQLITE_OPEN_READONLY) !== 0 && (flags & constants.SQLITE_OPEN_READWRITE) === 0
    : flags?.readonly === true || flags?.readOnly === true;
  return { open: true, readOnly };
}

export class Database {
  readonly #database: DatabaseSync;

  constructor(location: string, flags?: DatabaseFlags) {
    this.#database = new DatabaseSync(databaseLocation(location), databaseOptions(flags));
  }

  close(): void {
    this.#database.close();
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  query<Result = Record<string, unknown>, Parameters extends unknown[] = unknown[]>(sql: string) {
    const statement = this.#database.prepare(sql);
    return {
      all: (...parameters: Parameters): Result[] => statement.all(...parameters).map(plainRow) as Result[],
      get: (...parameters: Parameters): Result | null => (plainRow(statement.get(...parameters)) ?? null) as Result | null,
      run: (...parameters: Parameters) => statement.run(...parameters),
      values: (...parameters: Parameters): unknown[][] => {
        statement.setReturnArrays(true);
        try {
          return statement.all(...parameters) as unknown[][];
        } finally {
          statement.setReturnArrays(false);
        }
      },
    };
  }

  transaction<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
    const execute = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", args: Args): Result => {
      this.#database.exec(`BEGIN ${mode}`);
      try {
        const result = callback(...args);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.#database.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
    };
    const transaction = (...args: Args) => execute("DEFERRED", args);
    transaction.deferred = (...args: Args) => execute("DEFERRED", args);
    transaction.immediate = (...args: Args) => execute("IMMEDIATE", args);
    transaction.exclusive = (...args: Args) => execute("EXCLUSIVE", args);
    return transaction;
  }
}
