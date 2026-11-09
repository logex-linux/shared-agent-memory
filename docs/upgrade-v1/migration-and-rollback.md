# Shared Agent Memory v1 · Migration and recovery

Development and rehearsals use isolated database copies. The installed runtime
and canonical database are outside this implementation branch. Use a read-only
SQLite connection to inspect their state. The runtime constructor may migrate.

The migration gate checks a SQLite backup of Schema 5, latest revocations, old
and new schema opens, hashes of every record and vector, and interruption before
and after the migration commit. Schema 6 will record the existing revision and
all subsequent revisions. Older bodies absent from the backup remain unknown.

Recovery first applies the latest externally retained revocation ledger. A
versioned archive and a database backup have different roles. A database backup
preserves canonical receipts and projection inputs. The archive's guarantees
will be documented with its implementation and tests.

After migration, use compatibility retrieval inside the new runtime if a
ranking feature needs to be turned off. The old binary rejects Schema 6. A
recovery that restores Schema 5 requires a separately verified conversion from
the latest legal data and a retained new database. Where legacy cannot express
the needed state, retain the new database and repair within the new runtime.

Full P5 rehearsals and the final switch checklist remain pending.

P1 rehearsals verified the Schema 5 backup and Schema 6 projection with
matching bodies, hashes, revisions, index records and vector bytes. SIGKILL
immediately before commit left Schema 5 intact. SIGKILL after commit left the
complete Schema 6 copy. Four parallel openers converged on one version copy.
Use `node --test tests/versions.test.mjs` after building to repeat the synthetic
migration, scope, archive and revocation tests.

Use an explicitly isolated config for the versioned logical archive.

```sh
node dist/cli/main.js export --config "$ISOLATED_CONFIG" --project "$PROJECT_ID" --format versioned
node dist/cli/main.js import --config "$RESTORE_CONFIG" --input "$ARCHIVE_FILE"
node dist/cli/main.js import --config "$RESTORE_CONFIG" --input "$ARCHIVE_FILE" --mode restore --revocations "$LATEST_LEDGER" --commit
node dist/cli/main.js check --config "$RESTORE_CONFIG"
```

The new format is `shared-agent-memory/versions-v1`. Its `records` contain
every retained revision for each selected record. Restore requires matching
registered projects, checks body hashes and revision continuity, checks current
scope and privileges, and indexes the active latest revision with the configured
local model. A matching existing archive entry is idempotent. A conflicting
entry or revoked hash stops the restore. An archive that includes a verified
record requires an operator with verify permission. Keep using SQLite backup
for byte-identical vectors and for preservation of other canonical tables.

Revocation entries can carry `version_hashes`. Apply the latest ledger before
reading restored evidence. Managed exports containing forgotten content are
removed under the existing cleanup protocol. The new archive was refused by
the v0.4.8 importer on an isolated Schema 5 target. The old runtime also
reported `SCHEMA_TOO_NEW` when pointed at the Schema 6 rehearsal copy.

P2 advances the isolated development schema to 7 to add the canonical
relation and pending transition tables. Schema 5 and 6 open through the same
transactional migration path. Relation and proposal state are retained in
SQLite backups. The P1 logical version archive carries record revisions and
their embedded state metadata. It does not include relation rows or pending
plans, so use SQLite backups for full P2 recovery.

P3 advances to Schema 8 in the same migration transaction. It adds a graph
epoch and traversal and revocation indexes. The existing edge and record rows
are unchanged. Set `graph_enabled` to `false` for compatibility retrieval on
the upgraded database. A stored graph cursor must restart after this change.

The feedback ingestion stage advances to Schema 9. Its event inputs,
transactional projection jobs and association state are canonical tables.
SQLite backups retain them. The logical version archive remains a record
archive. Query receipts stay in the disposable sidecar and should be
regenerated after a restore. Existing connection configurations gain no
feedback permission.

Schema 10 adds the derived-revision erasure index, aliases for revoked import
keys and explicit source digests, and learned edge indexes. The erasure index
is populated from retained version bodies in the migration transaction.
Forgetting traverses current and retained historical derivations and exact
record-hash copies. Canonical endpoint deletion cascades to relation,
learning-event, projection-job and association rows. Older cursors fail on
generation change.

The external ledger may include `version_hashes`, `import_keys` and
`source_hashes`. Restore applies the ledger before reading the copy or
importing its content. A source digest blocks future ingestion carrying that
exact value. Matching a digest does not erase separate existing statements
that merely cite the same source, and hashes cannot identify paraphrases.
Managed exports are removed through the existing cleanup path. Previous chat
results and unmanaged backups remain outside the service's control.
