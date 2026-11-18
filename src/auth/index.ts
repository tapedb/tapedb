import { createAdapterFactory } from "better-auth/adapters";
import type { AuthDatabase, AuthCommand, AuthTables } from "./types";
export type { AuthDatabase, TapeDBAuthEnv } from "./types";
export interface TapeDBAuthOptions {
  database: AuthDatabase;
  debugLogs?: boolean;
}
/** Better Auth database adapter. Pass the app's dedicated AuthRoom stub. */
export function tapedbAuth({ database, debugLogs = false }: TapeDBAuthOptions) {
  return createAdapterFactory({
    config: {
      adapterId: "tapedb",
      adapterName: "TapeDB Auth",
      supportsDates: false,
      supportsBooleans: false,
      supportsJSON: false,
      supportsArrays: false,
      supportsNumericIds: false,
      supportsUUIDs: false,
      transaction: false,
      debugLogs,
    },
    adapter: ({ schema, getModelName, getFieldName }) => {
      const tables: AuthTables = {};
      for (const [key, table] of Object.entries(schema)) {
        const fields: AuthTables[string]["fields"] = {
          id: { source: "id", type: "string", required: true, unique: true },
        };
        for (const [name, field] of Object.entries(table.fields)) {
          fields[getFieldName({ model: key, field: name })] = {
            source: name,
            type: Array.isArray(field.type) ? "string" : field.type,
            required: field.required,
            unique: field.unique,
            ...(field.references
              ? {
                  references: {
                    model: getModelName(field.references.model),
                    field: getFieldName({
                      model: field.references.model,
                      field: field.references.field,
                    }),
                    onDelete: field.references.onDelete,
                  },
                }
              : {}),
          };
        }
        tables[getModelName(key)] = { model: key, fields };
      }
      let ready: Promise<void> | undefined;
      async function run<T>(command: AuthCommand): Promise<T> {
        await (ready ??= database.configure(tables).catch((error) => {
          ready = undefined;
          throw error;
        }));
        return (await database.execute(command)) as T;
      }
      return {
        create: ({ model, data }) => run({ action: "create", model, data }),
        findOne: ({ model, where }) => run({ action: "findOne", model, where }),
        findMany: ({ model, where, limit, offset, sortBy, select }) =>
          run({
            action: "findMany",
            model,
            where,
            limit,
            offset,
            sortBy,
            select: select?.map((field) => getFieldName({ model, field })),
          }),
        count: ({ model, where }) => run({ action: "count", model, where }),
        update: ({ model, where, update }) =>
          run({
            action: "update",
            model,
            where,
            data: update as Record<string, unknown>,
          }),
        updateMany: ({ model, where, update }) =>
          run({ action: "updateMany", model, where, data: update }),
        delete: async ({ model, where }) => {
          await run({ action: "delete", model, where });
        },
        deleteMany: ({ model, where }) =>
          run({ action: "deleteMany", model, where }),
        consumeOne: ({ model, where }) =>
          run({ action: "consumeOne", model, where }),
        incrementOne: ({ model, where, increment, set }) =>
          run({ action: "incrementOne", model, where, increment, data: set }),
      };
    },
  });
}

export { eraseAuthUser } from "./erasure";

export { authRoom as authDatabase } from "./server";
