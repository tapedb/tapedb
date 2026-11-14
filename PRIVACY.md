# Privacy and GDPR

What tapedb stores about the people using your app, where, for how long, and
how to answer their requests. You are the controller of that data. tapedb is
a library running in your Cloudflare account, and Cloudflare is your
processor. This page describes tapedb's behaviour; it is not legal advice.

## What is stored, and where

| Where | What | How long |
| --- | --- | --- |
| Durable Object SQLite, one per workspace | Your models' rows | Until deleted |
| | `_tx_log`: each write's operations (with values) and the time. Who made the write is not recorded | Covered rows deleted once older than half the retention (15 days by default) |
| | `_tx_receipts`: client transaction id, sequence, a hash of the operations, and the time | Half the retention (15 days by default) |
| | `_files`: path, size and content type of each upload | Until the file is deleted |
| R2 `DATA` bucket | Log segments (the `_tx_log` lines), snapshots of every table, a manifest | Superseded copies deleted within the retention (30 days by default) |
| R2 `FILES` bucket | Uploaded bytes | Deleted with the file, at once |
| Socket attachments (memory) | A connected client's `sub`, role, subscriptions, presence state and joined topics | While the socket is open |
| Broadcast topics | Messages | Not stored: delivered to connected sockets only |
| Worker logs | Workspace ids, counts, error messages. No row values, claim tokens or user ids | Your Workers Logs or Logpush settings |

Claim tokens are never put in a URL. HTTP requests carry them in
`Authorization`, and WebSocket upgrades in `Sec-WebSocket-Protocol`. If you
turn on request-header logging in Cloudflare, exclude those two headers.

tapedb does not record who made each write: nothing in the engine reads it.
If your app needs an audit trail, keep it in your own model, where it is
covered by your read rules, export and erasure like any other data. Use an
opaque user id as the claim's `sub` either way, not an email address.

## Retention

A value deleted or overwritten at time T is gone from every copy tapedb
keeps by T + retention: the local log, R2 log segments and older snapshots.
That holds even in a workspace that sees few writes (see
[README: History retention](README.md#history-retention)). Configure it with:

```ts
defineTapeDB({ schema, retention: { days: 30 } }); // at least 2
```

Two things sit outside tapedb's control:

- **Durable Object point-in-time recovery.** Cloudflare keeps 30 days of
  restorable history for every SQLite-backed Durable Object. tapedb never
  restores from it, but until it ages out, code running in your account could.
  So the effective bound is the greater of the retention and 30 days, and the
  default retention is 30 days to match.
- **R2 bucket lock rules.** A lock rule on the `DATA` or `FILES` bucket stops
  tapedb from deleting anything it covers. Don't add one to tapedb's buckets.

## Answering requests

**Access and portability (Art. 15, 20).** `db.$export()`, or
`tapedb export --workspace <id>`, streams every row and file entry the claim
may read as NDJSON, through the same read rules as any query. Run it with
the person's own claim to get what they may see, or with an owner's claim and
filter to the rows about them.

**Rectification (Art. 16).** Update the rows. The old values leave the
history within the retention.

**Erasure of a person (Art. 17).** Delete or overwrite the rows about them,
and delete their files with `db.$files.delete(path)`, which removes the bytes
from R2 at once. The deleted values leave the history within the
retention, and Cloudflare's point-in-time recovery within 30 days. Tell the person about that window.

**Erasure of a workspace (a whole tenant).** `tapedb erase --workspace <id>
--confirm <id>`, or `DELETE /engine/workspaces/:id` with an owner's claim,
deletes the workspace's R2 history, its files and its Durable Object
storage. The workspace answers `410` afterwards (see
[README: Erasing a workspace](README.md#erasing-a-workspace)).

## Where the data lives

By default Cloudflare places each workspace's Durable Object near its first
request, and R2 buckets wherever they were created.
`tapedb init --jurisdiction eu` keeps the Durable Objects and both buckets in
Cloudflare's EU jurisdiction, where they run and store data only in the EU,
and `tapedb deploy` refuses a config where the two disagree (see
[README: Data residency](README.md#data-residency)). Set it before the first
deploy.

Jurisdiction controls where the data is stored and processed. Cloudflare,
Inc. is still the processor, so your transfer assessment and Cloudflare's
data processing addendum still apply.

## Security

- Claims are short-lived HS256 tokens your Worker verifies on every request.
  The engine never mints them except through the development claim route,
  which `ENVIRONMENT=production` refuses and `tapedb deploy` will not ship.
- Every engine route needs a verified claim before a workspace is touched.
  Read and write rules apply inside the engine, and erasing needs an owner.
- Data reaches Cloudflare over TLS and is encrypted at rest by Cloudflare in
  Durable Object storage and R2.
