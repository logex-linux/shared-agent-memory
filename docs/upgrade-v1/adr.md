# ADR 001 · Versioned evidence on canonical SQLite

Accepted for isolated implementation. Release baseline is v0.4.8 at
`fd79df2df2f898aa373b6b521eb362615eec47c7`.

- The canonical database owns immutable revision bodies and the current record.
  Migration copies the existing revision as the oldest available revision.
  Each later revision commits atomically with the latest pointer and indexes.
  Existing IDs, stored bodies, hashes, index rows and vectors survive migration.
- The old body hash retains its original meaning. New event or state metadata
  is inside the record and covered by a versioned hash envelope. Provenance,
  project scope and the existing five values of `kind` remain independent.
- Record time is when a revision entered this library. Event time comes from
  source evidence. Effective time is a half-open interval. A missing boundary
  remains unknown. A query at an effective time cannot use the database's
  recorded time as an event date.
- An exact revision read is evidence review. Its content offsets refer to its
  own body. It checks present access and revocations and cannot promote an old
  revision to the current answer. Unavailable pre-migration history is a gap.
- Corrections retain the memory ID and create a revision. A sourced change in
  applicable fact creates a successor. Supersession closes the predecessor's
  known interval and advances its revision in the same transaction as the
  successor, relations, dependency invalidation and receipt. Unknown subjects
  or incomparable contexts retain separate objects.
- Decision state, lifecycle, verification and applicability are independent.
  A relation binds source and destination revisions and its source evidence.
  `supersedes` points from successor to predecessor. `supports` and
  `contradicts` point from the evidence to the claim. Context variants and
  related evidence may be traversed in either direction with the direction
  preserved. `dependencies` remains authoritative for derived evidence.
- Initial graph expansion stays within one project or global. Permission and
  current endpoint revision checks apply to every step. Learning stays within
  the same domain. A graph query pins generation, graph epoch and the initial
  effective time. Graph-off continuations ignore graph-only epoch changes.
  Projection jobs and their watermark live in canonical SQLite.
- The sidecar remains disposable and serialized. An opaque page receipt
  identifies the exact ID/revision pairs materialized for the named connection.
  It does not attest to client delivery or the correctness of feedback.
  Repeated reads create no canonical learning event.
- Forget erases all available revisions and the dependent subtree, then revokes
  each deleted hash. Ordinary association neighbors retain their content.
  Restore must apply the latest external ledger before making results visible.
- Existing request shapes and non-extended bodies retain their behavior.
  An explicit versions list uses the existing item and byte budgets. A version
  archive uses a distinct wire format so v0.4.8 cannot import a subset.
  Compatibility mode within the upgraded runtime preserves the latest data.
  Direct downgrade of a Schema 6 database to v0.4.8 is unsupported.
