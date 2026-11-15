# Privacy and GDPR

What tapedb stores about the people using your app, where, for how long, and
how to answer their requests. You are the controller of that data. tapedb is
a library running in your Cloudflare account, and Cloudflare is your
processor.

## What is stored, and where

| Where | What | How long |
| --- | --- | --- |
| Durable Object SQLite, one per workspace | Your models' rows | Until deleted |
| | `_tx_log`: each write's operations (with values) and the time. The writer's `sub` and role only with `audit: true` | Covered rows deleted once older than half the retention (15 days by default) |
| | `_tx_audit`, only with `audit: true`: for each changed row, the model, row id, sequence, time, action and the writer's `sub` and role | Deleted once older than half the retention (15 days by default); gone from R2 copies within the full retention |
| | `_tx_receipts`: random client transaction id, sequence and time; an operation hash while recent (an HMAC under `TAPEDB_KEY_SECRET` when the schema has personal fields) | Id, sequence and time for the workspace lifetime; hash removed after half the retention (15 days by default). Superseded R2 copies leave within the full retention |
| | `_files`: path, size, content type and uploader (the claim's `sub`) of each upload | Until the file is deleted |
| R2 `DATA` bucket | Log segments (the `_tx_log` lines), snapshots of every table, a manifest | Superseded copies deleted within the retention (30 days by default) |
| R2 `DATA` key prefix | Per-subject AES-GCM keys wrapped with `TAPEDB_KEY_SECRET`, named by subject HMAC | Until subject or workspace erasure |
| R2 `FILES` bucket | Uploaded bytes | Deleted with the file, at once |
| Socket attachments, and `_socket_state` / `_socket_parts` past 12 KiB | A connected client's `sub`, role, subscriptions, presence state and joined topics; a message arriving in parts until its last part | While the socket is open |
| Broadcast topics | Messages | Not stored: delivered to connected sockets only |
| `_topic_buffer` (Durable Object SQLite) | Recent broadcast messages and their sender's `sub` | `topics.replaySeconds` (60 s by default; 1,000 messages per topic at most) |
| Claim limiter Durable Objects | A token count per HMAC of a caller's IP or subject (never the IP or subject itself) | Deleted once the bucket has refilled: a minute by default |
| Worker logs | Workspace ids, counts, error messages. No row values, claim tokens or user ids | Your Workers Logs or Logpush settings |

Receipts contain no row values or writer identity. Storage grows by one small
receipt per transaction with a client id. Use a random id for each new write;
receipt ids are not user ids. Workspace erasure removes the receipts too.

Claim tokens are never put in a URL. HTTP requests carry them in
`Authorization`, and WebSocket upgrades in `Sec-WebSocket-Protocol`. If you
turn on request-header logging in Cloudflare, exclude those two headers.

By default tapedb does not record who made each row write. Files are the
exception: their uploader is kept for file rules. `defineTapeDB({ audit: true })`
records the writer of every write (see [README: Audit](README.md#audit)); that
history is bounded by the retention, read only by admins and owners, and not
part of `$export()`. A writer's entries leave every copy within the
retention, which is how an erasure request for them is answered; erasing the
workspace removes them at once. Use an opaque user id as
the claim's `sub`, not an email address: the audit stores it as given.

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
  For ordinary plaintext the effective bound is the greater of retention and 30 days; personal ciphertext becomes unreadable when its R2 subject key is deleted. The
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

**Erasure of a person (Art. 17).** Mark personal string and JSON fields with
`.personal({ subject: "self" })` or a string subject field. An owner calls
`db.$erasePerson(subject)` to delete the subject key from R2. SQL, transaction
logs, snapshots and Cloudflare recovery copies hold ciphertext that can no
longer be decrypted; reads return `null` with `$erased` field names. Delete
ordinary fields and files separately. Plaintext stored before encryption was
enabled still follows the history retention and Cloudflare's 30-day window.
Exports contain decrypted values: their copies and any external key backups
need their own erasure. The wrapping secret must stay stable, including moves;
losing it loses access to every personal field.

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
[README: Data residency](README.md#data-residency)). `tapedb move` relocates
existing workspaces, including their rows, receipts, snapshots, log segments
and indexed file bytes. The source remains readable while it is frozen;
after the destination is ready, traffic switches and source objects and
SQLite storage are removed. A routing tombstone contains only the workspace
id and destination jurisdiction. Cloudflare's point-in-time recovery window
still applies to the original Durable Object's plaintext data.

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
