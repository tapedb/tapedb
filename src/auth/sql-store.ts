import type { SqlExecutor, SqlValue } from "../engine/tx-sql";
import { balancedJoin } from "../engine/sql-binding";
import type { AuthDatabase, AuthTables, AuthCommand, AuthWhere } from "./types";
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const tableName = (model: string) => "_auth_" + model;
function value(input: unknown): SqlValue {
  if (input === undefined || input === null) return null;
  if (
    typeof input === "string" ||
    (typeof input === "number" && Number.isFinite(input))
  )
    return input;
  throw Error("Unsupported auth database value");
}
/** The same synchronous SQL implementation runs in AuthRoom and adapter tests. */
export class AuthSqlStore implements AuthDatabase {
  private tables: AuthTables = {};
  constructor(private sql: SqlExecutor) {
    const exists = sql.one(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='__tapedb_auth_schema'",
    );
    if (exists) {
      const stored = sql.one(
        "SELECT definition FROM __tapedb_auth_schema WHERE id=1",
      );
      if (typeof stored?.definition === "string")
        this.tables = JSON.parse(stored.definition);
    }
  }
  async configure(tables: AuthTables) {
    this.sql.transactionSync(() => {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS __tapedb_auth_schema (id INTEGER PRIMARY KEY CHECK(id=1), definition TEXT NOT NULL)",
      );
      const previous = this.sql.one(
        "SELECT definition FROM __tapedb_auth_schema WHERE id=1",
      );
      if (typeof previous?.definition === "string") {
        const existing = JSON.parse(previous.definition) as AuthTables;
        for (const [model, { fields }] of Object.entries(existing)) {
          if (!tables[model])
            throw Error(
              "Auth schema removal requires an explicit migration: " + model,
            );
          for (const [name, field] of Object.entries(fields)) {
            if (
              JSON.stringify(tables[model].fields[name]) !==
              JSON.stringify(field)
            )
              throw Error(
                "Auth schema change requires an explicit migration: " +
                  model +
                  "." +
                  name,
              );
          }
        }
      }
      for (const [model, { fields }] of Object.entries(tables)) {
        const table = quote(tableName(model));
        const definition = (
          name: string,
          field: (typeof fields)[string],
          alter = false,
        ) => {
          let ddl =
            quote(name) +
            " " +
            (field.type === "number" || field.type === "boolean"
              ? "REAL"
              : "TEXT");
          if (name === "id") ddl += " PRIMARY KEY NOT NULL";
          else if (!alter && field.required) ddl += " NOT NULL";
          if (field.references) {
            const r = field.references;
            const behavior = r.onDelete ?? "cascade";
            if (
              ![
                "cascade",
                "restrict",
                "set null",
                "no action",
                "set default",
              ].includes(behavior)
            )
              throw Error("Unsupported auth foreign key action");
            ddl +=
              " REFERENCES " +
              quote(tableName(r.model)) +
              "(" +
              quote(r.field) +
              ") ON DELETE " +
              behavior.toUpperCase();
          }
          return ddl;
        };
        this.sql.exec(
          "CREATE TABLE IF NOT EXISTS " +
            table +
            " (" +
            Object.entries(fields)
              .map(([name, f]) => definition(name, f))
              .join(",") +
            ")",
        );
        const existing = new Set(
          this.sql
            .all("PRAGMA table_info(" + table + ")")
            .map((row) => row.name),
        );
        for (const [name, f] of Object.entries(fields)) {
          if (!existing.has(name)) {
            if (f.required)
              throw Error(
                "Adding a required auth field requires an explicit migration: " +
                  model +
                  "." +
                  name,
              );
            this.sql.exec(
              "ALTER TABLE " +
                table +
                " ADD COLUMN " +
                definition(name, f, true),
            );
          }
          if (f.unique && name !== "id")
            this.sql.exec(
              "CREATE UNIQUE INDEX IF NOT EXISTS " +
                quote(tableName(model) + "_" + name + "_unique") +
                " ON " +
                table +
                "(" +
                quote(name) +
                ")",
            );
        }
      }
      this.sql.exec(
        "INSERT INTO __tapedb_auth_schema(id,definition) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
        JSON.stringify(tables),
      );
    });
    this.tables = tables;
  }
  async profile(
    id: string,
  ): Promise<{ id: string; name: string; image: string | null } | null> {
    const entry = Object.entries(this.tables).find(
      ([, table]) => table.model === "user",
    );
    if (!entry) return null;
    const [model, table] = entry;
    const row = (await this.execute({
      action: "findOne",
      model,
      where: [{ field: "id", operator: "eq", value: id }],
    })) as Record<string, unknown> | null;
    if (!row) return null;
    const field = (source: string) =>
      Object.entries(table.fields).find(([, f]) => f.source === source)?.[0] ??
      source;
    return {
      id,
      name:
        typeof row[field("name")] === "string"
          ? (row[field("name")] as string)
          : "",
      image:
        typeof row[field("image")] === "string"
          ? (row[field("image")] as string)
          : null,
    };
  }
  private field(model: string, name: string) {
    if (
      !Object.hasOwn(this.tables, model) ||
      !Object.hasOwn(this.tables[model].fields, name)
    )
      throw Error("Unknown auth field " + model + "." + name);
    return quote(name);
  }
  private where(
    model: string,
    where: AuthWhere[] = [],
  ): { sql: string; params: SqlValue[] } {
    const params: SqlValue[] = [];
    const and: string[] = [],
      or: string[] = [];
    for (const w of where) {
      let field = this.field(model, w.field),
        input = w.value;
      if (w.mode === "insensitive") {
        field = "lower(" + field + ")";
        input = Array.isArray(input)
          ? input.map((v) => (typeof v === "string" ? v.toLowerCase() : v))
          : typeof input === "string"
            ? input.toLowerCase()
            : input;
      }
      let condition: string;
      if (input === null || input === undefined) {
        if (w.operator !== "eq" && w.operator !== "ne")
          throw Error("Invalid auth null comparison");
        condition = field + (w.operator === "ne" ? " IS NOT NULL" : " IS NULL");
      } else if (w.operator === "in" || w.operator === "not_in") {
        if (!Array.isArray(input)) throw Error("Auth IN requires an array");
        for (const item of input) value(item);
        condition =
          field +
          (w.operator === "not_in" ? " NOT IN " : " IN ") +
          "(SELECT value FROM json_each(?))";
        params.push(JSON.stringify(input));
      } else if (
        ["contains", "starts_with", "ends_with"].includes(w.operator)
      ) {
        if (typeof input !== "string")
          throw Error("Auth string operator requires a string");
        if (w.operator === "contains") {
          condition = "instr(" + field + ",?)>0";
          params.push(input);
        } else {
          condition =
            w.operator === "starts_with"
              ? "substr(" + field + ",1,length(?))=?"
              : "substr(" + field + ",length(" + field + ")-length(?)+1)=?";
          params.push(input, input);
        }
      } else {
        const ops: Record<string, string> = {
          eq: "=",
          ne: "<>",
          gt: ">",
          gte: ">=",
          lt: "<",
          lte: "<=",
        };
        if (!ops[w.operator]) throw Error("Unknown auth comparison");
        condition = field + ops[w.operator] + "?";
        params.push(value(input));
      }
      (w.connector === "OR" ? or : and).push(condition);
    }
    // Keep parameter order identical to predicate order, with SQL's normal AND/OR grouping.
    // Better Auth combines all AND predicates as one group, then OR predicates.
    if (and.length && or.length) {
      const ordered = [
        ...where.filter((w) => w.connector !== "OR"),
        ...where.filter((w) => w.connector === "OR"),
      ];
      if (ordered.some((w, i) => w !== where[i]))
        return this.where(model, ordered);
    }
    const groups = [...(and.length ? [balancedJoin(and, " AND ")] : []), ...or];
    return {
      sql: groups.length ? balancedJoin(groups, " OR ") : "1=1",
      params,
    };
  }
  async execute(command: AuthCommand): Promise<unknown> {
    const { action, model } = command;
    if (
      ![
        "create",
        "findOne",
        "findMany",
        "count",
        "update",
        "updateMany",
        "delete",
        "deleteMany",
        "consumeOne",
        "incrementOne",
      ].includes(action)
    )
      throw Error("Unknown auth action");
    if (!Object.hasOwn(this.tables, model))
      throw Error("Unknown auth model " + model);
    const table = quote(tableName(model));
    const predicate = this.where(model, command.where);
    const entries = Object.entries(command.data ?? {}).filter(
      ([, v]) => v !== undefined,
    );
    for (const [name, v] of entries) {
      this.field(model, name);
      value(v);
    }
    const match =
      action === "updateMany" || action === "deleteMany"
        ? predicate.sql
        : "id IN (SELECT id FROM " +
          table +
          " WHERE " +
          predicate.sql +
          " LIMIT 1)";
    return this.sql.transactionSync(() => {
      if (action === "create")
        return this.sql.one(
          "INSERT INTO " +
            table +
            " (" +
            entries.map(([n]) => this.field(model, n)).join(",") +
            ") VALUES (" +
            entries.map(() => "?").join(",") +
            ") RETURNING *",
          ...entries.map(([, v]) => value(v)),
        );
      if (action === "count")
        return Number(
          this.sql.one(
            "SELECT COUNT(*) AS n FROM " + table + " WHERE " + predicate.sql,
            ...predicate.params,
          )?.n ?? 0,
        );
      if (action === "findOne" || action === "findMany") {
        const limit = action === "findOne" ? 1 : (command.limit ?? 100);
        const offset = command.offset ?? 0;
        if (
          !Number.isSafeInteger(limit) ||
          limit < 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          throw Error("Invalid auth pagination");
        const order = command.sortBy
          ? " ORDER BY " +
            this.field(model, command.sortBy.field) +
            (command.sortBy.direction === "desc" ? " DESC" : " ASC") +
            ",id ASC"
          : " ORDER BY id ASC";
        const columns = command.select?.length
          ? command.select.map((name) => this.field(model, name)).join(",")
          : "*";
        const rows = this.sql.all(
          "SELECT " +
            columns +
            " FROM " +
            table +
            " WHERE " +
            predicate.sql +
            order +
            " LIMIT ? OFFSET ?",
          ...predicate.params,
          limit,
          offset,
        );
        return action === "findOne" ? (rows[0] ?? null) : rows;
      }
      if (
        action === "delete" ||
        action === "deleteMany" ||
        action === "consumeOne"
      ) {
        if (action === "consumeOne")
          return (
            this.sql.one(
              "DELETE FROM " + table + " WHERE " + match + " RETURNING *",
              ...predicate.params,
            ) ?? null
          );
        return this.sql.exec(
          "DELETE FROM " + table + " WHERE " + match,
          ...predicate.params,
        );
      }
      const params: SqlValue[] = [];
      const assignments: string[] = [];
      for (const [name, v] of entries) {
        assignments.push(this.field(model, name) + "=?");
        params.push(value(v));
      }
      for (const [name, delta] of Object.entries(command.increment ?? {})) {
        if (
          entries.some(([n]) => n === name) ||
          this.tables[model].fields[name]?.type !== "number" ||
          !Number.isFinite(delta)
        )
          throw Error("Invalid auth counter");
        const field = this.field(model, name);
        assignments.push(field + "=COALESCE(" + field + ",0)+?");
        params.push(delta);
      }
      if (!assignments.length) {
        if (action === "updateMany") return 0;
        return (
          this.sql.one(
            "SELECT * FROM " + table + " WHERE " + predicate.sql + " LIMIT 1",
            ...predicate.params,
          ) ?? null
        );
      }
      const query =
        "UPDATE " + table + " SET " + assignments.join(",") + " WHERE " + match;
      if (action === "updateMany")
        return this.sql.exec(query, ...params, ...predicate.params);
      return (
        this.sql.one(query + " RETURNING *", ...params, ...predicate.params) ??
        null
      );
    });
  }
}
