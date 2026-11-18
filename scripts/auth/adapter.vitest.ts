import { DatabaseSync } from "node:sqlite";
import {
  testAdapter,
  normalTestSuite,
  caseInsensitiveTestSuite,
  authFlowTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { tapedbAuth } from "../../src/auth";
import { AuthSqlStore } from "../../src/auth/sql-store";
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
const store = new AuthSqlStore({
  exec: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
  all: (sql, ...params) => db.prepare(sql).all(...params) as never,
  one: (sql, ...params) => db.prepare(sql).get(...params) as never,
  transactionSync(fn) {
    db.exec("SAVEPOINT auth_test");
    try {
      const result = fn();
      db.exec("RELEASE auth_test");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO auth_test");
      db.exec("RELEASE auth_test");
      throw error;
    }
  },
});
const { execute } = await testAdapter({
  adapter: () => tapedbAuth({ database: store }),
  runMigrations: async () => {
    db.exec("PRAGMA foreign_keys=OFF");
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '_auth_%' OR name='__tapedb_auth_schema')",
      )
      .all())
      db.exec('DROP TABLE "' + String(name).replaceAll('"', '""') + '"');
    db.exec("PRAGMA foreign_keys=ON");
  },
  tests: [
    normalTestSuite(),
    caseInsensitiveTestSuite(),
    uuidTestSuite(),
    authFlowTestSuite(),
  ],
  onFinish: async () => db.close(),
});
execute();
