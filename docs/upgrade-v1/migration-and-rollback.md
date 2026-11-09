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

Migration, fault injection and rollback rehearsals are pending.
