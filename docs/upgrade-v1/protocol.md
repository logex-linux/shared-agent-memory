# Shared Agent Memory v1 · Protocol

The installed v0.4.8 protocol remains documented in [protocol.md](../protocol.md).
This document records the proposed v1 additions and implementation status. Each
stage adds its executable examples here after its acceptance checks.

| Contract | Stage | Status |
| --- | --- | --- |
| Exact version expansion and event metadata | P1 | In implementation |
| Effective time, decision state and atomic transitions | P2 | Planned |
| Bounded related-evidence paths | P3 | Planned |
| Authorized feedback and dry-run consolidation | P4 | Planned |

Current requests retain their ID, CAS, connection scope, source and evidence
semantics. Version expansion will accept an explicit list of `memory_id` and
`revision` pairs as a fourth mutually exclusive selector. It will report
budget-deferred pairs and use offsets in the selected revision's own body.
