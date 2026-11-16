# Independent source review — 2026-11-16

Baseline: `19b5f1d78541d46f2938cf35f9bc91c00a9b720f`.
A separate read-only agent reviewed the implementation without making fixes.
The implementing agent addressed the findings and the reviewer inspected the
remediation, including two follow-up findings. This is an independent agent
source review, not a human audit or a guarantee of security.

| Finding | Remediation |
| --- | --- |
| Missing-row update/upsert/merge bypassed create roles | Authorize the resolved action inside the transaction |
| Sequential operations checked stale rows | Check each operation immediately before applying it |
| Rules received SQLite booleans and JSON instead of API values | Share stored-to-API conversion for old and incoming values |
| Link/unlink omitted changed foreign keys from rule context | Include the new parent or null value |
| Exports exposed unreadable file metadata | Apply file and attachment read rules to every export page |
| Multipart sockets accumulated unbounded state | Bound message bytes, parts, pending IDs and aggregate assembly; bound topic replay |
| Erasure raced sockets and in-flight durability work | Close admission and drain tracked work before cleanup |
| Erasure could lose its intent during cleanup | Persist intent before R2 deletion; atomically replace local tables with a tombstone; retry failures |
| Bulk compiled queries omitted root read authorization | Authorize before selecting matching rows |
| Upload rules checked preliminary metadata only | Reauthorize actual metadata and current attachments before committing the file index |
| Browser queues could cross backends or accounts | Scope IndexedDB by backend and claim subject; verify token subject; quarantine legacy queues |
| Worker byte writes could complete after room erasure | Execute bytes inside tracked room requests and clean bytes after thrown metadata failures |

The reviewer found no additional concrete blocker in the final storage and
outbox remediation pass. The review was source-only: the reviewer did not run
tests or validate Cloudflare behavior. Regression tests accompany the fixes;
CI and deployed runtime validation remain separate evidence.

## Release acceptance — 0.1.0

The independent review above was done by an agent, not a person. For 0.1.0
the maintainer accepts it as gate 6's independent source review, together with
the follow-up review in [SECURITY-REVIEW.md](SECURITY-REVIEW.md) and the
deployed-runtime checks below. The remaining risk is that a person reviewing
the same code could find what the agent reviews did not. Security reports are
handled as described in [SECURITY.md](SECURITY.md).

Accepted by Brandon Diaz, 2026-11-16.

## Runtime validation

The remediation passed 572 tests, typechecking, builds and packed npm consumer
checks. CI also passed Chromium persistence, secret scanning, and the packed
workerd consumer and recovery suite. Deployed Cloudflare checks restored
31,108 rows, a file and a retry receipt after class deletion; the erased
workspace restored empty. The jurisdiction move and EU checks passed.

The release candidate after the follow-up fixes (`c9ddef9`) passed the same
checks: 583 tests and the packed npm consumer checks in `verify`; the packed
workerd scenarios and drills locally; and on Cloudflare (staging build
`640e13b4`) every scenario, the class-deletion drill restoring 31,108 rows, a
file and a retry receipt, an erased workspace restoring empty, the move into
the EU jurisdiction and the EU checks. Later commits before the tag change
documentation only.
