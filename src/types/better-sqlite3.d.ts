declare module 'better-sqlite3' {
  export type SqliteValue = string | number | bigint | Buffer | null;
  export type SqliteRow = Record<string, SqliteValue>;

  export interface Statement {
    // 默认 T = SqliteRow（保持既有调用不变）；调用处可传行类型，如 .get<NodeRow>(id)。
    all<T = SqliteRow>(...params: unknown[]): T[];
    get<T = SqliteRow>(...params: unknown[]): T | undefined;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }

  export default class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    exec(sql: string): unknown;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    function(name: string, options: { deterministic?: boolean; varargs?: boolean; directOnly?: boolean }, fn: (...args: unknown[]) => unknown): this;
    function(name: string, fn: (...args: unknown[]) => unknown): this;
    backup(destinationFile: string): Promise<unknown>;
    close(): void;
  }
}
