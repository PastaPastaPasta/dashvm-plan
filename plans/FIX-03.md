# PLAN: FIX-03 Rehearse scheduled host-fault recovery under the existing policy

Working artifact. Never staged, never committed. Delete when the task ships.

Base: `v5.0-dev` at `5f1e0ccdce` (identical to the issue's source anchor, so no line drift).
Branch: `dashvm/fix-03`. Single part, single PR. Tier: xhigh (confirmed, see section 9).

## 1. Acceptance in my words

Deliver, as tests plus a durable reference chapter, evidence for the owner's chosen policy
(normal protocol upgrades only, no emergency pause, no recovery binary, no activation-height
override, no guest-skip rule):

1. Three failure classes are kept apart and each is pinned by a test that drives the real
   block-execution entry points, not a unit that merely rejects a direct call:
   - **paid failure**: a transition that fails deterministically stays in the block, is charged,
     and the chain advances;
   - **node-local failure**: one node cannot execute a block; that node stops until repaired and
     then re-executes the same block to the same app hash; the block's validity for the rest of
     the network is unchanged;
   - **reproducible host fault in the scheduled phase**: every node fails every proposal at the
     scheduled-event point, before any ordinary transaction is looked at, empty blocks included;
     no transaction removal can route around it; block production stops.
2. The fault is reproduced *before ordinary transactions* (the scheduled-event integration point
   the scheduling DIP names: after DAO events, before `process_raw_state_transitions`).
3. The existing recovery path is identified from the code and rehearsed: an execution-and-fee
   identical software hotfix installed on every node resumes the chain at the same height with
   the same app hash a never-faulted node computes, with no state leaked by the failed attempts
   and a clean restart from disk.
4. The halt limitation is reported: an ordinary signalling upgrade cannot progress on a halted
   chain (votes are written inside the block transaction, tallied only on an epoch-change block,
   activated only by a later block), so a repair that changes execution or fees has no
   in-protocol path and needs a coordinated release. This goes in the book chapter and the PR
   body. No new mechanism is introduced.

Capability requirements: none listed. Modules JOBS, ABCI, INTEGRATION: JOBS does not exist in
this tree (no `execution/contracts/scheduling`), so the rehearsal marks the phase position in
ABCI and the tests live in the strategy suite (INTEGRATION).

## 2. What the tree says (inspected, with drift notes)

- No DashVM code anywhere in `packages/` (`grep dashvm|dash_vm|DashVM` is empty). Latest
  protocol version is 14 (`packages/rs-platform-version/src/version/mod.rs:36`). The memory
  pack's v15..v17 scaffolding lives in other open PRs, not on this base; irrelevant here because
  this task changes no version table.
- Block execution: `packages/rs-drive-abci/src/execution/engine/run_block_proposal/v0/mod.rs`
  (470 lines). Order: version check, follow check, epoch upgrade, chain lock verify,
  `update_core_info`, `update_validator_proposed_app_version` (the upgrade vote, written into the
  block transaction and the counter's block cache), withdrawal events, `run_dao_platform_events`,
  `process_raw_state_transitions`, address/anchor/withdrawal cleanup, fees, root hash,
  validator set update. Every per-block event uses a bare `?`.
- Halt surfaces (rs-drive-abci): `prepare_proposal`/`process_proposal` handlers propagate
  `Err` (`abci/handler/{prepare_proposal,process_proposal}.rs`), `abci/app/full.rs:224-235` maps
  it through `error_into_exception` to a `ResponseException`; `main.rs:626` installs a panic hook
  that cancels the node. Per-transition errors are *not* halts: `process_raw_state_transitions/v0`
  turns them into `InternalError` results, the proposer strips them (`TxAction::Removed`, with
  savepoint rollback) and validators reject a block that still contains one
  (`process_proposal.rs:353`).
- Tenderdash side, verified on tag v1.7.0 (dashmate pins `dashpay/tenderdash:1.7`,
  `packages/dashmate/configs/defaults/getBaseConfigFactory.js:377`):
  `internal/consensus/block_executor.go` panics when `CreateProposalBlock` (PrepareProposal)
  returns an error and `mustEnsureProcess` panics on a ProcessProposal error;
  `internal/consensus/state_prevoter.go` `handleError` prevotes nil on `ErrBlockRejected`
  (a Reject status) and panics on any other error; `internal/consensus/replay.go`
  `catchupReplay` re-dispatches every WAL message of the current height on restart, so the same
  proposal is re-executed by the same binary. There is no knob to skip one proposal.
- Upgrade mechanics: votes are recorded per block by
  `drive.update_validator_proposed_app_version` inside `run_block_proposal_v0`; the tally runs
  only in `upgrade_protocol_version_on_epoch_change_v0` on an epoch-change block; activation is
  the `PlatformVersion::get(next)` switch in `run_block_proposal/mod.rs` on the first block of
  the next epoch. All three need committed blocks.
- Existing coordinated-recovery precedents in the tree (all software releases gated by network
  id plus height or epoch, none an in-protocol mechanism):
  `abci/handler/{info,prepare_proposal,process_proposal}.rs` skip the app-hash check on
  mainnet `evo1` below 33000; `abci/handler/finalize_block.rs` tolerates the Busy commit at
  `evo1` 32326..32329; `execution/engine/consensus_params_update/{v0,v1}` push emergency
  consensus params on mainnet epoch 3 and testnet epoch 1480;
  `check_for_desired_protocol_upgrade/v0` lowered the threshold to 51 percent for the emergency
  move to version 3.
- Existing test seams: `process_raw_state_transitions/v0/mod.rs:31` `test_fault_injection`
  (`#[cfg(test)]`, `pub(crate)`, thread-local, one-shot; unreachable from the strategy binary).
  `#[cfg(feature = "testing-config")]` reads of `self.config.testing_configs` inside shipped
  `v0` modules: `finalize_block_proposal/v0/mod.rs:163`, `should_checkpoint/v0/mod.rs:37`,
  `store_platform_state/v0/mod.rs:15`, `batch/is_allowed/v0/mod.rs:22`. That is the accepted
  shape for a test-only hook in consensus code, and the one this plan follows.
- `PlatformTestConfig` (`config.rs:872`): `#[cfg(feature = "testing-config")]`, derives
  `Clone, Debug`, manual `Default` and `default_minimal_verifications()`. Exactly one struct
  literal without a spread exists outside `config.rs`:
  `tests/strategy_tests/test_cases/voting_tests.rs:50`.
- Features: production Docker builds use `console,grovedbg,replay` (+ `shielded_test_data`),
  never `testing-config` or `mocks` (`Dockerfile:454`, `.github/workflows/release.yml:186`).
  The crate's own dev-dependency enables `testing-config, mocks, shielded_test_data`. No other
  workspace crate depends on `drive-abci`.
- Strategy harness: `tests/strategy_tests/{execution,strategy}.rs`; `mimic_execute_block`
  panics on a prepare error, so a halting fault must be driven through the `Application` trait
  directly, as `test_cases/process_proposal_collision_tests.rs` does (its request builders are
  private to that module). Two platforms built with the same seed are deterministic twins
  (all randomness is `StdRng::seed_from_u64`, start time is `GENESIS_TIME_MS`). Restart from
  disk: `TempPlatform::open_with_tempdir` plus `store_platform_state: true` and carrying the mock
  RPC over with `std::mem::take`, as `upgrade_fork_tests.rs:728-736` does.
- CI: PR runs execute only `comprehensive_mixed_operations` and `process_proposal_collision`
  from the strategy binary (`.github/workflows/tests-rs-workspace.yml:370,398`); the rest runs on
  push and nightly. The collision module was added to the PR gate because it pins a
  consensus-halt regression and runs in under a second.
- Book: `book/src/architecture/component-pipeline.md` documents the lifecycle and the 18-step
  order; `book/src/SUMMARY.md` lists chapters; `book.yml`/`book-preview.yml` build with mdbook on
  changes under `book/**` (mdbook is not installed locally).

## 3. Approach

One PR, `test(drive-abci): rehearse a reproducible scheduled host fault and the existing
recovery path`. No protocol behaviour changes. Three surfaces:

### 3.1 Test-only fault hook at the scheduled-event integration point (rs-drive-abci)

`packages/rs-drive-abci/src/config.rs`
- Add `pub scheduled_event_host_fault: bool` to `PlatformTestConfig` (doc: makes every block
  proposal fail at the scheduled-event integration point with an internal error, standing in
  for a reproducible engine or host defect in a scheduled job; arm on one node to model a
  node-local fault, on every node to model the network-wide halt class; compiled out of
  production). Default `false` in both `Default` and `default_minimal_verifications()`.
- Add `#[cfg(feature = "testing-config")] pub const SCHEDULED_EVENT_HOST_FAULT_MESSAGE:
  &str = "injected scheduled-event host fault (testing config)";` so tests assert on the exact
  error rather than on "some error".

`packages/rs-drive-abci/src/execution/engine/run_block_proposal/v0/mod.rs`
- Directly after `self.run_dao_platform_events(...)?;` and before
  `self.process_raw_state_transitions(...)`, insert a commented, cfg-gated block:

  ```rust
  // Scheduled-event integration point: due contract jobs run here, after the DAO events
  // and before the ordinary state transitions. A defect in this phase that every node
  // reproduces cannot be routed around by dropping a transaction: it fires before any
  // transaction is looked at, on empty blocks too. The hook below stands in for such a
  // defect so the failure class and its recovery can be rehearsed. Compiled out of
  // production builds.
  #[cfg(feature = "testing-config")]
  if self.config.testing_configs.scheduled_event_host_fault {
      return Err(Error::Execution(ExecutionError::CorruptedCodeExecution(
          SCHEDULED_EVENT_HOST_FAULT_MESSAGE,
      )));
  }
  ```
  `ExecutionError` and `Error` are already imported; add the `use crate::config::...` behind
  the same cfg. Production compilation of `v0` is unchanged (the block does not exist without the
  feature). This follows the four existing `testing_configs` reads inside shipped `v0` modules
  and the `test_fault_injection` precedent; it is deliberately not a new `run_block_proposal`
  generation (no logic change, so no `vN`, per the conventions).

Why `Err` and not a panic: the `Err` path is the consensus-visible shape of a per-block-event
defect (bare `?`) and is observable in-process; a panic ends the process through the panic hook
and cannot be observed by a test that then rehearses recovery. The chapter documents that a
panic in the same phase has the same network effect.

`packages/rs-drive-abci/tests/strategy_tests/test_cases/voting_tests.rs:50`
- Add `scheduled_event_host_fault: false,` to the only spread-less literal.

### 3.2 Tests

Unit tests, `run_block_proposal/mod.rs` `tests` module (same style as the three existing tests
there: genesis with activation info, `set_genesis_time`, `fast_forward_to_block`, `proposal_at`):
- `should_fail_the_whole_proposal_at_the_scheduled_event_point_when_the_host_fault_is_armed`:
  platform built with `scheduled_event_host_fault: true` at latest version, empty raw
  transactions, proposal at the next height with `app` = latest protocol version. Assert
  `matches!(result, Err(Error::Execution(ExecutionError::CorruptedCodeExecution(m))) if m ==
  SCHEDULED_EVENT_HOST_FAULT_MESSAGE)`. This pins the class: the whole proposal is an `Err`,
  not a `ValidationResult` error and not a per-transition result, and it fires with zero
  transactions.
- `should_not_fail_the_proposal_at_the_scheduled_event_point_when_unarmed`: same setup with
  the flag off; assert the result is not the injected error (and `Ok` + valid if the synthetic
  state lets the block finish; the implementer checks this once and keeps the stronger assert
  when it holds).

Strategy tests, new file `packages/rs-drive-abci/tests/strategy_tests/test_cases/scheduled_host_fault_tests.rs`
(`mod scheduled_host_fault_tests;` in `test_cases/mod.rs`). Module doc explains the three
classes and points at the book chapter. Helpers (private to the module): `strategy()` and
`config(fault: bool)` copied from the collision tests with `store_platform_state: true`;
request builders taking explicit inputs (height, time, proposer pro tx hash, quorum hash,
proposed app version, transactions) so they work after the outcome has been destructured;
`twins(seed)` building two platforms and running the same 5-block chain on both, asserting equal
committed app hashes as the test premise. All requests use `tenderdash_abci::Application` on
`FullAbciApplication` and assert on `ResponseException.error.contains(SCHEDULED_EVENT_HOST_FAULT_MESSAGE)`.

- `paid_failure_stays_in_the_block_pays_and_the_chain_advances`: the `failures.rs` fixture
  (dashpay all-mutable contract, bad update with a skipped position at block 3, expected code
  10411), 10 blocks, `verify_state_transition_results: true`. Assert the block-3 result in
  `state_transition_results_per_block` has `code == 10411` and `gas_used > 0`, and the chain
  reached height 10. (If 10411 turns out to be an unpaid result on this base, switch to the
  `required_since_update_tests.rs` fixture; the point is a *paid* consensus error.)
- `node_local_fault_stops_only_that_node_and_it_catches_up_after_repair`: twins A and B; arm B.
  A prepares block H (empty) and processes its own prepared block: Accept, app hash X. B
  processes the equivalent request (same height, time, proposer, core height, quorum hash, app
  version, no transactions): `ResponseException` with the injected message; B's committed root
  hash is unchanged. Disarm B ("repair"), rebuild its `FullAbciApplication`, process the same
  request again: Accept with app hash X. Block validity never depended on B.
- `reproducible_scheduled_fault_halts_every_node_before_ordinary_transactions`: twins A and B;
  arm both after 5 healthy blocks. For rounds 0..=2, for two different proposers, with the
  request's `proposed_app_version` set to latest+1 (nodes signalling an upgrade while halted),
  with an empty transaction list and with one transaction: every `prepare_proposal` and every
  `process_proposal` on both nodes returns the injected exception. One attempt uses a block time
  past the epoch boundary: still the exception (the epoch-change block cannot be produced
  either). After the attempts: committed root hash unchanged on both nodes;
  `drive.fetch_versions_with_counter(None, ..)` holds no vote for latest+1;
  `next_epoch_protocol_version()` unchanged. This is the halt and the reason a signalling
  upgrade cannot progress.
- `execution_identical_hotfix_resumes_the_chain_at_the_same_height_and_app_hash`: continues
  the previous scenario. "Hotfix" = disarm and restart from disk
  (`open_with_tempdir(tempdir, config(false))`, carry the mock RPC over with `mem::take`), assert
  the reopened state is at the pre-halt height and app hash. Then `continue_chain_for_strategy`
  for 5 blocks on the recovered node A and, with the same seed and parameters, on a third
  never-faulted twin C. Assert equal final heights and committed app hashes, and that the
  persisted version counter only carries votes from real blocks. Also assert the committed
  counter has no residue from the halted attempts. (Implemented as the second half of the halt
  test if sharing the twins is simpler; keep the two assertions groups clearly labelled.)

CI gate: extend the two nextest filters in `.github/workflows/tests-rs-workspace.yml` (lines
370 and 398) with `or test(~scheduled_host_fault)` / `and not test(~scheduled_host_fault)` and
extend the comment block above them, mirroring the collision module: these tests pin a
consensus-halt class and run in a few seconds. Validate the YAML with actionlint from the
release tarball in `/tmp` (brew is denied for this user). Provisional: maintainers may move the
module to the push-only phase.

### 3.3 Reference chapter (book)

New `book/src/architecture/block-failure-classes.md`, listed in `book/src/SUMMARY.md` under
Architecture after Component Pipeline. Long-term documentation, not a design doc. Contents
(~200 lines, code paths cited by file):
1. Why every failure must be classified (replicated state machine).
2. Class 1, deterministic paid failure: `StateTransitionExecutionResult` variants, proposer
   `TxAction` mapping, validator rejection of `InternalError`/unpaid, savepoint rollback. For
   contracts: guest traps, rejections, bounds, failed native validation and a scheduled job's
   failed attempt are this class; never a halt.
3. Class 2, node-local failure: chain-lock verification against Core (Reject, nil prevote,
   `InvalidChainLock` / `ChainLockedBlockNotKnownByCore`), storage and cache errors
   (`Err`, ABCI exception, Tenderdash panic, node down until repaired), app-hash mismatch panics
   (restart self-heals). Does not change block validity; a repaired node re-executes to the
   same app hash. For contracts: a missing compiled artifact or a failed allocation is this
   class and must never become a paid result or an invalid block.
4. Class 3, reproducible per-block fault: bare `?` in a per-block event of
   `run_block_proposal_v0` (list the events and where the scheduled phase sits) or a panic;
   every node, every round, empty blocks too; Tenderdash panics; WAL replay re-executes the same
   proposal; no knob skips a height. Halt.
5. Why a signalling upgrade cannot progress: vote write, tally and activation all live inside
   blocks.
6. The existing coordinated recovery: an execution-and-fee identical hotfix (fix the defect,
   release, every validator installs and restarts, WAL replay succeeds, chain resumes at the
   same height and app hash; no protocol version, no state surgery). When the repair must
   change execution or fees: a coordinated release with a network-and-height gated rule, with
   the in-tree precedents listed in section 2. That is the accepted limitation: no emergency
   pause, no recovery binary, no activation-height override, no guest-skip rule.
7. The rehearsal tests and how to run them:
   `cargo test -p drive-abci --test strategy_tests scheduled_host_fault`.
8. Rules: a class-3 `Err` is never turned into a paid result; a class-2 failure is never turned
   into an invalid block; the scheduled phase is fallible only through `Err` (no `unwrap`); a
   scheduled job's trap is a class-1 result.
No task ids or ticket ids in the chapter or the PR body; describe follow-up work in words.

## 4. Versioning consequences

None. No `vN` generation, no `SystemLimits`, no fee schedule, no protocol-version table, no
consensus error code, no proto, no SDK surface. Byte-identical in production builds:
`run_block_proposal_v0` (the hook is `#[cfg(feature = "testing-config")]`), every other
versioned method, all of rs-drive and rs-dpp. Non-production changes: one field on the
test-only `PlatformTestConfig`, one test-only constant, tests, one workflow filter, one book
chapter.

## 5. Files

| File | Change | Lines |
|---|---|---|
| `packages/rs-drive-abci/src/config.rs` | field, defaults, constant | +18 |
| `packages/rs-drive-abci/src/execution/engine/run_block_proposal/v0/mod.rs` | cfg-gated hook + comment | +16 |
| `packages/rs-drive-abci/src/execution/engine/run_block_proposal/mod.rs` | 2 unit tests | +90 |
| `packages/rs-drive-abci/tests/strategy_tests/test_cases/scheduled_host_fault_tests.rs` | new module | +520 |
| `packages/rs-drive-abci/tests/strategy_tests/test_cases/mod.rs` | `mod` line | +1 |
| `packages/rs-drive-abci/tests/strategy_tests/test_cases/voting_tests.rs` | literal field | +1 |
| `.github/workflows/tests-rs-workspace.yml` | two filters, comment | +6/-2 |
| `book/src/architecture/block-failure-classes.md` | new chapter | +210 |
| `book/src/SUMMARY.md` | entry | +1 |

Estimated diff: about 860 lines added, 2 removed.

## 6. Local gate

```
cargo fmt --all
cargo clippy -p drive-abci --all-features --all-targets -- -D warnings
cargo check --workspace --all-targets          # PlatformTestConfig gained a field
cargo test -p drive-abci --lib run_block_proposal
cargo test -p drive-abci --test strategy_tests scheduled_host_fault
cargo test -p drive-abci --test strategy_tests process_proposal_collision
cargo test -p drive-abci --test strategy_tests run_chain_insert_one_new_identity_and_a_contract_with_bad_update
/tmp/actionlint .github/workflows/tests-rs-workspace.yml
```
Redirect each to a file and check the exit code. If a worktree build cannot see the new
symbols, use a private `CARGO_TARGET_DIR` (shared target fingerprint collision). The book
builds in CI (`book-preview.yml`); no local mdbook.

## 7. Provisional interpretations (repeat in the PR body)

1. The scheduled-event integration point is the position after `run_dao_platform_events` and
   before `process_raw_state_transitions` in `run_block_proposal_v0`, the processing order the
   scheduling draft proposes (engineering convention, not an owner decision). When the jobs
   phase lands, the hook moves inside it.
2. The paid-guest-failure class is represented by its native analogue, a paid consensus error
   transition, because no guest runtime exists on this base; the same test extends to a
   scheduled trap once jobs exist.
3. The node-local class is represented by one node failing its ProcessProposal with the same
   exception a storage fault produces; the chain-lock Reject path is documented, not driven
   (driving it needs a second mock Core RPC with the harness's masternode data).
4. The class-3 fault surfaces as `Err(ExecutionError::CorruptedCodeExecution)`; the panic
   sub-class is documented as equivalent in network effect.
5. Tenderdash behaviour is cited from tag v1.7.0 sources; the chapter names the files.
6. The new strategy module joins the PR gate next to the collision module.

## 8. Dependencies

`depends_on` is empty; nothing to waive. The refinement pointer to the live-paid scheduling
task is not a prerequisite: this rehearsal deliberately runs at the existing integration point
so the failure classes and the recovery report exist before the jobs phase is built. Enables the
upgrade-containment rehearsal that follows (it reuses the hook, the twins helper and the chapter).

## 9. Tier

xhigh confirmed. The change touches a consensus-critical file (`run_block_proposal_v0`) even
though the hook is compiled out, and the chapter's halt analysis must be exact.

## 10. PR body notes

`Refs #4688`, `Dash-Tasks: FIX-03` on its own line, the provisional list above, the byte-identical
statement, the Tenderdash citations, and the attribution footer from the config.
