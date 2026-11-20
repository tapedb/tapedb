# @tapedb/auth

Better Auth integration for [tapedb](https://tapedb.dev), a typed database for Cloudflare.
Users, sessions and members live in one dedicated auth Durable Object; workspace
roles come from stored membership.

```bash
npm install @tapedb/tapedb @tapedb/auth better-auth
```

```ts
import { tapedbAuth, eraseAuthUser, authDatabase } from "@tapedb/auth";
```

`npx @tapedb/cli init --auth` wires this up for a new project. The exports are
`tapedbAuth` (the Better Auth adapter factory), `eraseAuthUser` (the
`deleteUser.beforeDelete` hook) and `authDatabase` (the auth room stub).

## Two import paths, one module

`@tapedb/auth` is an alias, not a fork: it re-exports `@tapedb/tapedb/auth` and
pins the exact `@tapedb/tapedb` version it ships with. Either path works, and
the subpath stays supported:

```ts
import { tapedbAuth } from "@tapedb/auth";       // preferred
import { tapedbAuth } from "@tapedb/tapedb/auth"; // same module, still supported
```

`better-auth` is an optional peer dependency: installs that never import this
entry do not need it.
