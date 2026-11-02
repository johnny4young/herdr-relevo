# Relevo engineering audit — 2026-11-02

Baseline: `b53664ac8ab62ad0f2ecbaf756048329c435e84a` (0.5.1). This is a scoped engineering audit, not a production-readiness certification.

## Implemented proposals

- [PR #1](https://github.com/johnny4young/herdr-relevo/pull/1): protect edits from asynchronous save/reload races, serialize writes, ignore stale completions after close. Synthetic host regression tests exercise the actual editor module, not a reimplementation.
- [PR #2](https://github.com/johnny4young/herdr-relevo/pull/2): replace overlapping range walks in review highlighting with interval deltas. Complexity changes from up to O(rows × comments) to O(rows + comments). Neither proposal is assumed merged or released.

## Verification and limits

Combined audit working tree, Linux x64, Node **26.13.0**: Relevo **52/52**, file module **23/23**, Python hook **11/11**; ESLint **10.13.0** and whitespace checks passed. Baseline had 50/50, 6/6 and 11/11 respectively. Native **Herdr 0.1.12** `check` passed for relevo, relevo-files and relevo-agents after the changes. That command checks descriptions/eager native element construction; it does not prove deferred rendering, layout, asynchronous UI flows, or integration with live agents.

The official Linux app archive was downloaded from [Herdr releases](https://releases.herdr.dev/app/0.1.12/herdr-app-linux-x86_64.tar.gz) and SHA-256 matched the official manifest: `a265e6c925c487458406741ffa09d2fa0d3d4bd401a34ed8c01c336108e57c1f`.

An isolated full-app launch hit `cannot serve .../herdr-app.sock: Operation not permitted (os error 1)` and was terminated by the 10-second timeout. The failure is an environment socket restriction, not evidence of a Relevo defect. No security restriction was bypassed. **Native GUI CPU, RAM, rendering and end-to-end behavior remain unmeasured.** No live agent account, credential store or real session history was used.

Launch shape (with fresh directories, not a real user profile):

```sh
HOME="$AUDIT_HOME" HERDR_APP_HOME="$AUDIT_HOME/.config/herdr-app" timeout 10 "$HERDR_APP"
```

## Reproducible CPU/RAM measurement

Raw samples: [JSONL](2026-11-02-review-ranges.jsonl). The script in PR #2 compares the old algorithm with the proposed implementation using synthetic data. Separate Node processes, 4,000 rows, 50 recomputations per sample, 5 warmups, `--expose-gc`, median of 3 samples:

| Overlapping comments | CPU ms: reference → new | Wall ms: reference → new |
| --- | --- | --- |
| 25 | 106.045 → 47.998 | 94.998 → 37.190 |
| 1,000 (stress) | 2162.615 → 50.241 | 2154.464 → 40.913 |

Wall ranges were 91.507–102.404 vs 33.855–47.230 ms (25 comments), and 2023.701–2655.161 vs 36.876–94.960 ms (stress). Shared-cloud variability is substantial. CPU reduction here does **not** imply the same whole-application reduction. RSS across runs stayed approximately **72–73 MiB**: no meaningful RAM improvement was established. Both algorithms returned the same 4,000 marked rows.

```sh
node --expose-gc scripts/benchmark-review-ranges.mjs reference 25 50
node --expose-gc scripts/benchmark-review-ranges.mjs current 25 50
# Repeat each three times; also repeat with 1000 comments for the stress case.
```

Do not use heap deltas as a leak diagnosis: GC timing and retained benchmark output affect them. Next native measurement should compare the same platform/app build, synthetic fixture, 60-second idle window, repeated review navigation and editor open/edit/save/close cycles; report process-tree CPU, peak/steady RSS and settled post-cycle memory, not only one process snapshot.

## Prioritized next investigations (not implemented)

1. **Quota refresh boundedness.** `mods/relevo/quota.js` fetches lack an explicit deadline and account collection is sequential. Confirm native fetch cancellation support, then test one never-resolving provider and overlapping timer refreshes. Goal: bounded timeout, single-flight collection, per-account stale/error states without starving other accounts. Static risk, not a reproduced live provider outage.
2. **PR snapshot correctness.** `lib/github.js` caps own/requested PRs and review threads and does not bind CI display to an explicit head SHA. `inbox-prs.js` prunes addressed marks using the returned set. Add pagination or explicit partial-coverage metadata, preserve unseen marks on partial snapshots, and test a head change with stale CI and more than 30/20 PRs. Never imply a partial list is complete.
3. **Transactional handoff.** `handoff.js` launches the successor and then interrupts the source. Verify the host command's acknowledgement semantics before calling this a bug. Test failed launch, slow readiness and duplicate click; retain the source until successor readiness is confirmed, with visible recoverable state.
4. **Bounded ledger history.** `ledger.js` reads and splits the whole ledger before reverse traversal. Benchmark synthetic 10,000/1,000,000-row histories before choosing streaming tail, date shards or bounded aggregate storage. Do not silently discard history.

Existing inbox signature comparisons and scan coalescing already avoid some redundant work; a generic polling rewrite is not justified without a workload profile. Prefer reliability and bounded resource usage over adding another model/provider surface first.

## Public ecosystem evidence (reviewed 2026-11-02)

- [Agent Deck issue #2481](https://github.com/asheshgoplani/agent-deck/issues/2481) discusses skipping unchanged content in polling. This is analogous engineering evidence, not a benchmark of Relevo.
- [cmux feed design](https://github.com/manaflow-ai/cmux/blob/main/docs/feed.md) and [notifications](https://github.com/manaflow-ai/cmux/blob/main/docs/notifications.md) are useful comparators for durable activity, bounded in-memory state and request identity. Relevo could differentiate with reliable handoff state and clear stale/blocked/working status rather than another generic agent dashboard.
- [Moshi Herdr integration](https://getmoshi.app/docs/herdr), [herdr-web](https://github.com/eyalev/herdr-web) and [herdr-mobile](https://github.com/martebytes/herdr-mobile) already occupy remote/mobile access territory. A new mobile wrapper is not an original gap established by this audit.
- Public X posts [Moshi/Herdr announcement](https://x.com/odd_joel/status/2117239489349435755) and [agent-state confusion](https://x.com/loudernet/status/2117242865097011506) were readable in the cloud browser during research. The former is an announcement supported by integration documentation, not independently runtime-tested here; the latter is qualitative opinion, not quantified market demand.

**Recommendation (inference, medium confidence):** first harden bounded quota refresh and SHA-aware, coverage-aware PR state; then validate acknowledged handoffs using synthetic failure injection. These target trustworthy long-running operation in the current product. A small failure-injection experiment is stronger evidence than claiming market uniqueness from a limited search.
