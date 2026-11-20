# @tapedb/react-native

React Native support for [tapedb](https://tapedb.dev), a typed database for
Cloudflare: a durable queue for writes made offline, and a client factory that
wires it. React Native is a runtime, not a view layer, so this package needs
neither `react` nor `react-native`.

```bash
npm install @tapedb/tapedb @tapedb/react-native @react-native-async-storage/async-storage
```

```tsx
import { createReactNativeClient } from "@tapedb/react-native";
import { useLive } from "@tapedb/react";

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
  storage: myKeyValueStore, // getItem, setItem, removeItem, getAllKeys, plus a batch delete:
                            // multiRemove on v1/v2, removeMany on v3, or neither
});
```

The queue is scoped by `url` and `userId`, exactly like the browser's, so
recreating the client on an account change does not replay the previous
account's pending writes.

## The hooks are `@tapedb/react`'s

There are no React bindings here. On a device, use the same package the web uses:

```tsx
import { useLive } from "@tapedb/react";
```

It peers on React, which a React Native app already has. `@tapedb/react-native`
peers on `@react-native-async-storage/async-storage` (`^1.17.0 || ^2.0.0 || ^3.0.0`)
and on nothing else.

`@tapedb/react-native` never imports `react-native`, so it loads wherever JavaScript
runs. The queue keeps one storage key per pending write under a prefix, ordered by
`createdAt` rather than by key order, and a retry replaces its own entry.

A write made with the engine unreachable stays in the queue and is replayed when the
app starts again. A failed `setItem` costs the caller nothing: the entry stays in the
outbox, which is why the queue is durable for as long as the store behind it is.

`$flush()` resolves after one attempt rather than on acknowledgement, so a client
that needs to know a write landed has to look at its own state — offline, a resolved
flush leaves the entry queued.
