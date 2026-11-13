/**
 * Adapts a Durable Object's storage to the recovery SQL contract.
 *
 * `DurableObjectStorage.sql` provides the query cursor surface and
 * `DurableObjectStorage.transactionSync` provides the transaction primitive;
 * recovery needs both on one object.
 */

import { fitBindings } from "../sql-binding";
import type { RecoverySqlExecutor } from "./recovery";
import type { SqlValue } from "./sql";

export function durableObjectRecoverySqlExecutor(
  storage: DurableObjectStorage
): RecoverySqlExecutor {
  return {
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ) {
      const fitted = fitBindings(query, bindings);
      return storage.sql.exec<T>(fitted.sql, ...fitted.params);
    },
    transactionSync<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
