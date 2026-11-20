# @tapedb/react-native

React Native bindings for [tapedb](https://tapedb.dev), a typed database for
Cloudflare: the same hooks as `@tapedb/react`, plus a durable queue for writes
made offline.

```bash
npm install @tapedb/tapedb @tapedb/react-native @react-native-async-storage/async-storage react
```

```tsx
import { createReactNativeClient } from "@tapedb/react-native";
import { useLive } from "@tapedb/react-native";

const db = createReactNativeClient({ schema, url, workspace, userId, getToken });

const { data } = useLive(db.task.findMany({ where: { done: false } }));
```

## Why this package exists

A tapedb write is optimistic and goes into an offline queue first. In a browser
that queue is IndexedDB. React Native has no IndexedDB, so the queue would be
memory-only: a write made in a tunnel, or one still pending when iOS
suspends the app, was gone after a relaunch.

`createReactNativeClient` supplies an `AsyncStorageOutbox` instead — one
AsyncStorage key per pending write, listed back and replayed when the app
starts again, in the order the writes were made. That is the whole difference
from `createClient()`; nothing about the API changes.

```tsx
// Equivalent, if you want the queue in your own store:
import { AsyncStorageOutbox } from "@tapedb/react-native";

const db = createReactNativeClient({
  schema,
  url,
  workspace,
  userId,
  getToken,
  storage: myKeyValueStore, // getItem, setItem, removeItem, getAllKeys, multiRemove
});
```

The queue is scoped by `url` and `userId`, exactly like the browser's, so
recreating the client on an account change does not replay the previous
account's pending writes.

## Import paths

`@tapedb/react-native` re-exports `@tapedb/tapedb/react` and pins the exact
`@tapedb/tapedb` version it ships with, so the hooks are the core's own
bindings rather than a copy:

```tsx
import { useLive } from "@tapedb/react-native";      // preferred
import { useLive } from "@tapedb/tapedb/react";      // same module, still supported
```

`react` and `@react-native-async-storage/async-storage` are peer dependencies.
`@tapedb/react-native` never imports `react-native`, so it installs and imports
in Node — its own queue is exercised there against a fake store.
