# @tapedb/react

React bindings for [tapedb](https://tapedb.dev), a typed database for Cloudflare:
`useLive`, `useLivePage`, `usePresence` and `useBroadcast`.

```bash
npm install @tapedb/tapedb @tapedb/react react
```

```tsx
import { useLive, usePresence } from "@tapedb/react";

const { data, isLoading } = useLive(db.task.findMany({ where: { done: false } }));
const peers = usePresence(db, "board:" + boardId, { name, color });
```

## Two import paths, one module

`@tapedb/react` is an alias, not a fork: it re-exports `@tapedb/tapedb/react`
and pins the exact `@tapedb/tapedb` version it ships with. Either path works,
and the subpath stays supported:

```tsx
import { useLive } from "@tapedb/react";      // preferred
import { useLive } from "@tapedb/tapedb/react"; // same module, still supported
```

Hooks take the queries and rooms a `createClient()` client returns, so hooks
and plain calls share one socket, one cache and one outbox. React 19 is a peer
dependency; the React-free entry is `@tapedb/tapedb`.
