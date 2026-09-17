# FIX-09: Make readiness transport and missing-cache behavior deterministic

Working artifact. Never staged, never committed. Planned 2026-09-17 on `dashvm/fix-09` cut from
`origin/v5.0-dev` at `5f1e0ccdce` (latest protocol version 14 on the base; the open 5.0 siblings
raise it to 17). Tier stays **xhigh**: this is consensus (a new state transition type, a new
block-phase event, new Drive state, a fee group, activation timing).

## 0. Summary of the decision

FIX-09 delivers the whole compilation-readiness mechanism as native Platform consensus, in
three sequential PRs on `v5.0-dev`, and refines R08-12, R08-13 and R08-14 in the same code (the
issue lists FIX-09 as their refinement, not their dependent). The readiness report is a new
unpaid `StateTransition` variant signed by the evonode's **operator BLS key** (the key Core
already publishes in the masternode list and Platform already stores as key 0 of the operator
identity). Rounds, reports, crossings and deadlines live in Drive under the existing `Votes`
root (`112`) in a new `r` subtree. Threshold evaluation runs as a block-phase event right after
the DAO events, before ordinary transitions, on the same `block_platform_state` the block's
core-chain-locked height produced. Verification costs are paid from a per-round prefunded
specialized balance the deployer funds, under a new key `129` beside the voting fund `128`.
Local artifact absence is a node-readiness condition surfaced as a typed `NodeFault` error from
the preparation-service seam, never a consensus result and never a fee.

What this task does **not** build (delivered by others): the contract create/update transition
that carries a bundle (R06-05, PR #4717), permanent bundle storage (R06-04, R08-03), the
preparation service that compiles (R08-06), routing activation of a bundle into method tables
(R10-11, R11-14), refunds of unused preparation funding on cancellation (R08-14's refund half,
which needs R06-07's recorded payer; this task exposes the balance and the "empty it" operation
and wires the refund destination as a provisional identity credit). Because no sibling has
merged the bundle transition yet, rounds in this task are opened by an explicit Drive operation
(`open_readiness_round_operations`) that the future contract create/update converter calls;
until then only tests and the block-phase event call it. The whole mechanism is exercised end to
end in tests with synthetic bundle digests.

## 1. Acceptance in my words

1. **Bounded, deduplicated transport.** One report per evonode per round counts once. A
   retransmitted identical report is accepted as a no-op (mempool: same unique identifier, so
   Tenderdash deduplicates; block: idempotent, no second charge). A report for a stale round,
   wrong profile, wrong manifest or foreign network is rejected unpaid. The number of reports
   verified per block is capped by a protocol constant and the cap applies per round and per
   block. Nothing requires one paid transition per node: the transition is unpaid by the sender
   and the deployer's readiness fund pays a fixed verification fee per newly accepted report.
2. **Threshold-time eligibility pruning against one coherent membership view.** A GroveDB
   count tree keeps the raw distinct count. Whenever the raw count could satisfy
   `5*raw >= 4*N` (N from the block's agreed HPMN view after the membership update phase), the
   block event walks the round's reports in bounded pages against that single view, drops
   ineligible voters, and only a fully validated `5*Y >= 4*N` with `N > 0` records the crossing.
   Membership changes reconsider every open round even without a new report (a smaller N can
   cross). A paged walk that cannot finish in one block persists a cursor bound to the
   membership view; a membership change before the walk finishes invalidates the cursor and the
   walk restarts. No crossing is ever committed from a partial or stale scan.
3. **Committed chain time and a defined boundary.** Every timestamp is `block_info.time_ms` of
   the block that commits the fact. `T = crossing_time - accepted_time`, `wait = clamp(T, 2 min,
   1 h)`, `deadline = crossing_time + wait`. Activation happens at the first block boundary
   (this same event, at the start of the block) whose `time_ms >= deadline`. Membership changes
   after a committed crossing do not restart the timer. Reports accepted in block H become
   eligible at the start of block H+1 (the event runs before the transitions of a block).
4. **Replacement cancels old rounds and timers.** Opening a new round for a contract removes the
   previous pending round, its reports, its cursor and its deadline in the same batch; old
   reports cannot count for the new round because the report signs the round id. Cancellation
   removes the same and empties the readiness fund to the recorded payer. There is no automatic
   expiry: a round without enough reports stays pending forever.
5. **Missing artifacts make nodes unready, with no fee.** The preparation seam distinguishes
   three outcomes: a node whose local artifact is missing or whose compiler failed reports
   `NodeFault` (a typed drive-abci error the block loop turns into a node-local failure, never a
   consensus result), a node that has not finished preparation simply does not report, and a
   consensus-invalid report is a consensus rejection. No fee row exists for compilation, cold
   cache or repeated preparation; the fee table has exactly one readiness row (verification per
   accepted report) and it is charged to the deployer's fund.
6. **Tests separate retransmission, mechanism failure and withheld reports** (section 6).

Q10, Q11 and Q14 are restated in 2, 3 and 5. R08-12/13/14 acceptance is covered by 2, 3, 4.

## 2. What the tree says (inspected 2026-09-17, drift from the issue text noted)

- No readiness, DashVM or `rs-drive-contracts` code exists on the base. `packages/rs-dashvm-validation`
  exists only on `origin/dashvm/r08-01` (PR #4712, unmerged). Its `BundleDigest` (32 bytes,
  domain `dashvm-bundle-v1`) is the manifest hash a report binds; this task carries the digest
  as an opaque `[u8; 32]` and does not depend on that crate.
- `StateTransitionType` has 21 variants, `0..=20`; next free is **21**. No `DO NOT CHANGE ORDER`
  banner, but `#[repr(u8)]` plus positional bincode make appending the only safe edit. The
  `StateTransition` umbrella has 16 exhaustive matches in `rs-dpp/src/state_transition/mod.rs`
  (macros at L160-422, `active_version_range` L832, `name` L917, `signature` L994,
  `user_fee_increase` L1038, `owner_id` L1107, `inputs` L1134, `set_signature` L1171,
  `set_user_fee_increase` L1234, `sign_external_with_options` L1310, `validate_structure`
  L1912), plus `state_transition_types.rs` tests (`try_from(21u8).is_err()` at L226 must move
  to 22) and 21 `umbrella_*` json tests at L519-772.
- drive-abci processor traits under `execution/validation/state_transition/processor/traits/`:
  exhaustive matches in `address_balances_and_nonces.rs`, `address_witnesses.rs`,
  `addresses_minimum_balance.rs`, `basic_structure.rs`, `identity_balance.rs`,
  `identity_based_signature.rs`, `identity_nonces.rs` (v1 at L168), `is_allowed.rs`,
  `state.rs`; wildcard in `advanced_structure_*`, `prefunded_specialized_balance.rs`,
  `shielded_proof.rs`. `transformer/mod.rs` L84 is exhaustive. `execution_event/mod.rs` L185
  falls through to `Paid` (must get an arm). `check_tx_verification/v0/mod.rs` L57 wildcard.
- rs-drive: `state_transition_action/mod.rs` (enum at L56, `user_fee_increase` L118),
  `action_convert_to_operations/mod.rs` L35, `prove/prove_state_transition/v0/mod.rs` L66 and
  `verify/state_transition/verify_state_transition_was_executed_with_proof/v0/mod.rs` are
  exhaustive. `StateTransitionProofResult` (`rs-dpp/src/state_transition/proof_result.rs`) is
  `derive_more::TryInto`, no append-only marker; its consumers in `wasm-dpp2` and `rs-sdk` use
  wildcard arms.
- wasm: `wasm-dpp/src/state_transition/state_transition_factory.rs` L38 exhaustive;
  `wasm-dpp/src/identity/state_transition/transition_types.rs` L26 `todo!()` wildcard (add the
  discriminant to the mirror enum and the `From`); `wasm-dpp2/src/state_transitions/base/state_transition.rs`
  `action_type_number` L293, `identity_contract_nonce` L373, `identity_nonce` L411,
  `set_owner_id` L464, `set_identity_contract_nonce` L588, `set_identity_nonce` L666 exhaustive.
- `MasternodeVoteTransition` (16 files under
  `rs-dpp/src/state_transition/state_transitions/identity/masternode_vote_transition/`) is the
  template: signed by an identity key of a synthesized masternode identity, unpaid by the
  sender, `PaidFixedCost` with the fee credited to the pool and the prefunded fund debited by a
  drive operation in the action converter (`action_convert_to_operations/identity/masternode_vote_transition.rs`
  L34-58). Its validation lives in `execution/validation/state_transition/state_transitions/masternode_vote/`
  (`mod.rs` 11,587 lines, mostly tests; `advanced_structure`, `balance`, `nonce`, `state`,
  `transform_into_action`).
- Operator identity: `update_masternode_identities/get_operator_identity_keys/v0/mod.rs` L17-27
  stores `pub_key_operator` verbatim as key **0**, `KeyType::BLS12_381`, `Purpose::SYSTEM`,
  `SecurityLevel::CRITICAL`, `read_only: true`. Identity id is
  `Identifier::create_operator_identifier(pro_tx_hash, pub_key_operator)`
  (`get_operator_identifier/v0/mod.rs` L11-18). On operator key rotation a **new** identity is
  created (`update_operator_identity/v0/mod.rs` L70-80). The generic signature check
  (`common/validate_state_transition_identity_signed/v0/mod.rs`) accepts `BLS12_381` (L36-40)
  and honours `purpose_requirement()` / `security_level_requirement()` from the transition
  (L171-193), so a transition requiring `[Purpose::SYSTEM]` and `[SecurityLevel::CRITICAL]` is
  verified by the existing path with no new crypto. `NativeBlsModule::verify_signature`
  (`rs-dpp/src/bls/native_bls.rs` L8-41) is the Basic scheme over 48-byte G1 keys and 96-byte
  G2 signatures; `SimpleSigner` signs BLS (`simple-signer/src/signer.rs` L139).
- `PlatformConfig` (`rs-drive-abci/src/config.rs`) holds no private key. Signing a report is
  therefore an operator-side action outside drive-abci (the preparation service of R08-06 hands
  a signable payload to the operator key holder; dashmate's `core.masternode.operator.privateKey`
  is the material). This task defines the signable bytes and a `sign` helper in `rs-dpp` and an
  `rs-sdk` broadcast helper; it does not add a key to drive-abci.
- Block order (`execution/engine/run_block_proposal/v0/mod.rs`, 470 lines):
  `upgrade_protocol_version_on_epoch_change` L152, chain lock L162-242, **`update_core_info`
  L245-254** (masternode list from `core_chain_locked_height`, a no-op when the core height did
  not change), `update_validator_proposed_app_version` L256, withdrawals L269-305,
  **`run_dao_platform_events` L310-316** (`remove_votes_for_removed_masternodes`, then
  `check_for_ended_vote_polls`; `voting/run_dao_platform_events/v0/mod.rs`), **`process_raw_state_transitions`
  L319-327**, then end-of-block events. `block_platform_state` carries the updated HPMN list;
  `last_committed_platform_state` the previous one; `hpmn_masternode_list_changes(previous)`
  (`platform_state/accessors.rs` L554) diffs them.
- Membership predicate today: `hpmn_active_list_len()` (`accessors.rs` L306-311) counts HPMNs
  with `pose_ban_height.is_none()`; used by the protocol upgrade tally (`upgrade_protocol_version/v0/mod.rs`
  L61-70). `ValidatorV0::new_validator_if_masternode_in_state` additionally requires platform
  ports and node id (`platform_types/validator/v0/mod.rs` L23-39). The masternode vote strength
  path applies no ban filter.
- Prefunded specialized balances: root `40` (`RootTree::PreFundedSpecializedBalances`, a
  `SumTree`), child `128` (`PREFUNDED_BALANCES_FOR_VOTING`, `prefunded_specialized_balances/mod.rs`
  L26-65, whose doc comment reserves sibling keys for other purposes); `add`, `deduct` (v0/v1),
  `empty`, `fetch`, `prove` exist and are keyed by a 32-byte id under `[40, 128]`. Credit
  conservation reads the `40` sum (`calculate_total_credits_balance/v2/mod.rs` L49-56), so a new
  sibling `129` under `40` is inside conservation for free.
- Votes root `112` (`RootTree::Votes`, `NormalTree`) has children `d`, `c`, `e`
  (`drive/votes/paths.rs` L29-65; genesis in `votes/setup/setup_initial_vote_tree_main_structure/v0/mod.rs`).
  `check_for_ended_vote_polls` bounds work per block with
  `validation_and_processing.event_constants.maximum_vote_polls_to_process` (`u16`, 2 in every
  table). End-date queues are `[112, e, encode_u64(time)]` with a range query
  (`query/vote_polls_by_end_date_query.rs` L53-76).
- Versioning shapes: `DRIVE_VERSION_V9`, `DRIVE_ABCI_METHOD_VERSIONS_V10`,
  `DRIVE_ABCI_VALIDATION_VERSIONS_V10`, `DRIVE_VOTE_METHOD_VERSIONS_V2`,
  `STATE_TRANSITION_SERIALIZATION_VERSIONS_V3`, `VOTING_VERSION_V2`, `FEE_VERSION2`,
  `SYSTEM_LIMITS_V4` are the base's newest; all are full literals. The siblings (section 3.9)
  already claim `DRIVE_VERSION_V10`, `DRIVE_ABCI_METHOD_VERSIONS_V11`, `SYSTEM_LIMITS_V5`,
  `FEE_VERSION3`, `DRIVE_ABCI_QUERY_VERSIONS_V4`, `DPP_VALIDATION_VERSIONS_V6`,
  `create_initial_state_structure` v4 and `perform_events_on_first_block_of_protocol_change`
  v2. v15/v16 placeholders are byte-identical across all six siblings.
- Consensus error codes on the base: basic state-transition band max 10603 (r06-05 takes
  10604), voting state band 40300-40306, prefunded band 40400-40401.
- Error classes: a `Result::Err` from a single transition becomes
  `StateTransitionExecutionResult::InternalError` (`process_raw_state_transitions/v0/mod.rs`
  L212-219), which `process_proposal` rejects; a bare `?` from a block event aborts the block
  on every node. `ExecutionError` is `@append_only`.
- Ed25519: `dashcore/eddsa` is exposed through the dpp feature `ed25519-dalek`, which
  drive-abci's non-dev dpp dependency (`features = ["abci"]`) does not enable. Not needed: the
  report is BLS-signed (decision 3.2).

## 3. Design

### 3.1 Storage (rs-drive, allocation A09 for the new inner tags; provisional keys)

Under `[112]` a new child `r` (`READINESS_TREE_KEY: char = 'r'`, provisional, chosen next to
`d`/`c`/`e`), created at genesis by `setup_initial_vote_tree_main_structure` **v1** (copies v0
and adds the `r` tree and its two children) and on upgrade by
`perform_events_on_first_block_of_protocol_change` **v3** (section 3.8). Layout, all keys
provisional under A09:

```text
112 Votes
 └─ r  Readiness (NormalTree)
     ├─ 0  rounds (NormalTree)                      key: contract_id (32)
     │      └─ contract_id (NormalTree)
     │           ├─ 0  round record   Item: ReadinessRound (versioned, serialized)
     │           ├─ 1  reports        CountTree; key: pro_tx_hash (32) -> Item: ReadinessReportRecord
     │           └─ 2  scan cursor    Item: ReadinessScanCursor (absent when no scan is open)
     └─ 1  deadlines (NormalTree)                   key: encode_u64(deadline_ms) (NormalTree)
              └─ contract_id (32) -> Item: empty
```

- `ReadinessRound` (rs-dpp `voting::readiness::round`, `#[platform_serialize(unversioned)]`
  versioned enum `V0`): `contract_id`, `round_id: [u8; 32]`, `bundle_digest: [u8; 32]`,
  `version: u32` (contract version the bundle activates), `preparation_profile: u16`
  (`DashVmVersion.preparation` generation the report binds), `accepted_at_ms`,
  `accepted_at_height`, `status: Pending | Crossed { crossing_ms, deadline_ms } `,
  `funding_id: Identifier` (the readiness fund id), `payer: ReadinessPayer::Identity(Identifier)`
  (typed, one variant now; the contract-bucket variant arrives with FIX-08's typed owners).
  `round_id = hash_double(network_magic || contract_id || version || bundle_digest ||
  accepted_at_height)`; the height makes a replacement of the same bundle a new round.
- `ReadinessReportRecord`: `accepted_at_height` and the report's `preparation_profile`. The
  count tree's `count_value_or_default()` is the raw distinct count (one key per `pro_tx_hash`,
  so duplicates cannot inflate it).
- `ReadinessScanCursor`: `membership_core_height: u32`, `membership_hpmn_len: u32`,
  `next_pro_tx_hash: Option<[u8; 32]>`, `eligible_so_far: u32`, `pruned_so_far: u32`. A cursor is
  valid only while the block's `block_info.core_height` equals `membership_core_height` and the
  round is still `Pending`.
- Deadline queue `[112, r, 1, encode_u64(deadline)]` mirrors the vote-poll end-date queue and
  is read with the same range-query shape (`..=encode_u64(block_time)`).

New Drive methods (all under `drive/votes/readiness/`, versioned `mod.rs` + `v0/mod.rs`,
`*_operations` shape, estimated-cost aware):
`open_readiness_round_operations` (replaces any previous pending round: deletes
`[112, r, 0, contract_id]` with `SubelementsDeletionBehavior::DeleteChildren`, removes the old
deadline entry if `Crossed`, inserts the new record, empty count tree and fund creation op),
`cancel_readiness_round_operations` (same removal plus `empty_prefunded_specialized_balance`
on `129` and an `AddToIdentityBalance` of the remainder to the payer),
`insert_readiness_report_operations` (insert-if-absent into the count tree; returns whether the
report was new so the fee is charged once), `fetch_readiness_round`, `fetch_readiness_round_raw_count`
(the count tree element's count), `fetch_readiness_reports_page(contract_id, after, limit)`
(path query over `[112, r, 0, contract_id, 1]`), `store_readiness_scan_cursor_operations`,
`clear_readiness_scan_cursor_operations`, `record_readiness_crossing_operations` (status to
`Crossed`, deadline queue insert), `fetch_readiness_rounds_due(at_ms, limit)`,
`activate_readiness_round_operations` (removes the round subtree and the deadline entry, and
returns the `ReadinessRound` so ABCI can hand it to the activation hook), `prune_readiness_reports_operations`
(deletes named report keys). Prefunded: `PREFUNDED_BALANCES_FOR_READINESS: u8 = 129`
(provisional) with path helpers mirroring `128`; the existing `add`/`deduct`/`empty`/`fetch`/`prove`
methods gain a `ReadinessFund` variant of a new `PrefundedBalancePurpose` argument in **v1**
generations (v0 stays byte-identical and keeps `128`); the typed op enum gains
`CreateNewReadinessFund { id, add_balance }` and `DeductFromReadinessFund { id, remove_balance }`.
Fund id `= hash_double(b"dashvm-readiness-fund-v1" || round_id)` (provisional).

Proof/verify: `drive::verify::voting::verify_readiness_round` (round record and raw count by
contract id) and `verify_readiness_report` (one report by contract id and pro_tx_hash), both
`verify`-feature only, plus their `FeatureVersion` slots. `prove_state_transition` and
`verify_state_transition_was_executed_with_proof` gain the report arm, returning a new
`StateTransitionProofResult::VerifiedReadinessReport(Identifier, [u8; 32])` (contract id,
pro_tx_hash), appended.

### 3.2 The report transition (rs-dpp, WIRE allocation A02; discriminant provisional)

`StateTransition::CompilationReadinessReport(CompilationReadinessReportTransition)` appended as
variant **21**, `StateTransitionType::CompilationReadinessReport = 21`. Module
`state_transitions/identity/compilation_readiness_report_transition/` copied from the
masternode vote layout. `V0` fields (all in the signable hash except the last two):

```text
pro_tx_hash: Identifier          the reporting evonode
contract_id: Identifier
round_id: [u8; 32]               binds the round (and through it network, version, digest, height)
bundle_digest: [u8; 32]          repeated so a mismatch is a cheap structural rejection
preparation_profile: u16         the dashvm preparation generation compiled against
nonce: IdentityNonce             operator identity nonce, so a replay of an old report is rejected
signature_public_key_id: KeyID   exclude_from_sig_hash; must be 0 in v0 (the operator key)
signature: BinaryData            exclude_from_sig_hash; 96-byte BLS
```

Signing: the report is identity-signed by the **operator identity**
(`create_operator_identifier(pro_tx_hash, pub_key_operator)`) with `purpose_requirement() =
[Purpose::SYSTEM]` and `security_level_requirement() = [CRITICAL]`; `owner_id()` returns the
operator identity id; `unique_identifiers()` is `"{base64(pro_tx_hash)}-{contract_id}-{round_id
hex prefix}"` so a retransmission collides in the mempool and a report for a different round
does not. `is_identity_signed` stays true (default). `active_version_range` is
`PROTOCOL_VERSION_17..=LATEST_VERSION` (provisional, the 5.0 version). `calculate_min_required_fee`
returns 0 (unpaid by the sender; a new `state_transition_min_fees.compilation_readiness_report`
row set to 0 in every schedule). Why the operator key and not the platform node id: the node id
is an `EDDSA_25519_HASH160` key whose verification path in `signing.rs` is a script-hash style
"signature must be empty" check (L116-123), so it cannot sign a transition today; the operator
key already verifies through the generic path with no new crypto. This is a provisional binding
under A10 and is called out in the PR body.

Validation in drive-abci (`state_transitions/compilation_readiness_report/`), mirroring the
masternode vote row `DriveAbciStateTransitionValidationVersion { basic_structure: Some(0),
advanced_structure: Some(0), identity_signatures: None, nonce: Some(0), state: 0,
transform_into_action: 0 }` in a new `compilation_readiness_report_state_transition` field:

- basic structure (`network_type` + version only): `signature_public_key_id == 0`, signature
  length 96, `preparation_profile` equals the active `platform_version.dashvm.preparation`
  when that table exists (`None` on the base: then reject with the new
  `CompilationReadinessNotActiveError`; the r08-01 table makes it `Some` at 17), so a node on a
  profile the network does not run cannot even reach state.
- signature: generic identity-signed path (no balance, no revision), like the masternode vote.
- nonce: operator identity nonce, generation 0 shared with the vote's `nonce/v1` logic.
- advanced structure with state (after `transform_into_action` fetched the round): `pro_tx_hash`
  is in `block_platform_state.hpmn_masternode_list()` and not PoSe-banned, its
  `pub_key_operator` equals the signing key's data (the identity id already binds it, this is
  the explicit check), `round_id` and `bundle_digest` match the stored round, round is
  `Pending` (a `Crossed` round still accepts reports but they no longer matter; provisional:
  accept and charge, they are harmless and keep the count honest for a later membership drop
  that cannot happen once crossed; simpler rule: **reject** with `ReadinessRoundAlreadyCrossedError`,
  chosen), the report is not already present (`ReadinessReportAlreadyPresentError`, unpaid so
  a retransmission costs the fund nothing).
- prefunded pre-check: the round's fund holds at least one verification fee
  (`ReadinessFundInsufficientError`); `uses_prefunded_specialized_balance_for_payment()` true.
- `transform_into_action` produces `CompilationReadinessReportAction` (rs-drive
  `state_transition_action/identity/compilation_readiness_report/`) carrying the round; the
  converter emits `UpdateIdentityNonce` (operator identity), `InsertReadinessReport` (a new
  `VoteOperationType`-style typed op: `ReadinessOperationType::InsertReport`) and
  `DeductFromReadinessFund { fee }`; `ExecutionEvent::PaidFixedCost { fees_to_add_to_pool: fee }`
  where `fee = fee_version.dashvm_readiness.report_verification_fee` (section 3.6).
- CheckTx: `validates_full_state_on_check_tx() = true` (unpaid transition, same reason as the
  vote), `has_basic_structure_validation = true`.
- Per-block bound: `DriveAbciValidationConstants.maximum_readiness_reports_to_verify_per_block:
  u16` (provisional **128**, the register's "128 reports per batch"); the processor counts
  accepted readiness reports in `BlockExecutionContext` and returns
  `StateTransitionExecutionResult::NotExecuted(NotExecutedReason::ReadinessReportBudgetExhausted)`
  for the rest (the proposer delays them, `TxAction::Delayed`, so they stay in the mempool; a
  validator processing a proposal with more than the cap rejects the block through the existing
  `NotExecuted` handling). `NotExecutedReason` gains the variant (it is not append-only marked
  but is appended anyway).

Consensus errors (new files under `errors/consensus/{basic,state}/readiness/`, codes
provisional, chosen after the siblings' 10604 and 10277): basic
`CompilationReadinessNotActiveError` **10605**, `ReadinessReportInvalidSignatureKeyError`
**10606** (key id not 0 or signature not 96 bytes), `ReadinessReportProfileMismatchError`
**10607**; state `ReadinessRoundNotFoundError` **40307**, `ReadinessRoundMismatchError`
**40308** (round id or digest), `ReadinessRoundAlreadyCrossedError` **40309**,
`ReadinessReportAlreadyPresentError` **40310**, `ReadinessReporterNotEligibleError` **40311**
(not an HPMN, banned, or operator key mismatch), `ReadinessFundInsufficientError` **40402**.
All appended to their enums, mirrored in `wasm-dpp/src/errors/consensus/consensus_error.rs`
and `wasm-dpp2/src/consensus_error.rs`.

### 3.3 Block-phase event (drive-abci, allocation A11; phase convention provisional)

`run_dao_platform_events` **v1** (copy of v0) calls, after `check_for_ended_vote_polls`,
`self.process_compilation_readiness(last_committed_platform_state, block_platform_state,
block_info, transaction, platform_version)`. That is the single defined boundary: after the
block's membership update (`update_core_info` ran at L245), before this block's transitions.
The DIP's "reports accepted in block H become eligible at H+1" follows from the position.

`process_compilation_readiness` v0 (`platform_events/readiness/process_compilation_readiness/`),
new `DriveAbciReadinessMethodVersions { process_compilation_readiness: OptionalFeatureVersion,
membership_view: FeatureVersion }` sub-struct on `DriveAbciMethodVersions` (backfilled `None`/0
in v1..v10, `Some(0)` in the new v12). Steps, all bounded, all through `block_info.time_ms`:

1. **Membership view.** `ReadinessMembershipView::from_state(block_platform_state)` (versioned
   `membership_view` v0): the set of `pro_tx_hash` of `hpmn_masternode_list()` entries with
   `pose_ban_height.is_none()` and `platform_node_id.is_some()`, plus `n = len`, plus
   `core_height = block_info.core_height`. This is the provisional native predicate for A10
   (the "active eligible evonode" binding): it equals `hpmn_active_list_len()` narrowed to
   nodes that can actually run Platform. The same view object serves every round in the block.
2. **Due activations first.** `fetch_readiness_rounds_due(block_info.time_ms,
   maximum_readiness_activations_per_block)` (provisional constant **4**); for each,
   `activate_readiness_round_operations` and call the activation hook
   `Platform::on_readiness_round_activated(round, block_info, transaction, platform_version)`,
   which in this task records nothing beyond removing the round (routing activation is R10-11's;
   the hook is the seam and is documented as such). No quorum recheck at the deadline.
3. **Reconsideration set.** Rounds to evaluate this block: every pending round whose raw count
   changed since its last evaluation (tracked by a `last_evaluated_raw_count` field on the
   record), plus **all** pending rounds when `block_platform_state.hpmn_masternode_list_changes(
   last_committed_platform_state)` is non-empty or `block_info.core_height` changed. Bounded
   by `maximum_readiness_rounds_to_evaluate_per_block` (provisional **8**), walked in
   contract-id order from a persisted `[112, r]`-level cursor key so a large backlog is fair
   across blocks.
4. **Cheap gate.** With `raw = count tree value`: if `n == 0` or `5*raw < 4*n` (checked u128),
   the round cannot cross; clear any open scan cursor, store `last_evaluated_raw_count`, done.
5. **Paged validation.** Otherwise walk the reports page by page
   (`maximum_readiness_reports_to_validate_per_block`, provisional **512** across all rounds
   in a block), each report either eligible (`pro_tx_hash` in the view) or pruned (deleted
   from the count tree in this batch). If the walk does not finish, persist the cursor bound to
   `core_height` and `n`; if it finishes, `Y = eligible`, and `5*Y >= 4*n` records the crossing
   with `crossing_ms = block_info.time_ms`, `T = crossing_ms - accepted_at_ms` (saturating,
   accepted is always earlier), `wait = T.clamp(120_000, 3_600_000)`, `deadline = crossing_ms
   + wait` (checked), deadline queue insert. A cursor whose `core_height` differs from the
   block's, or whose `n` differs from the view's, is discarded and the walk restarts from the
   first report; the count tree is authoritative for "raw", so pruning inside an abandoned walk
   is still correct (pruned voters were ineligible under a view that is now older; they are
   re-added only by a fresh report, which the evonode can send if it is eligible again).
6. Deadline arithmetic constants live in `SystemLimits`: `readiness_additional_wait_min_ms`
   (120_000) and `readiness_additional_wait_max_ms` (3_600_000), so a later change is a table
   edit (conventions: numbers in the tables).

Errors inside the event are node faults (`?` aborts the block on every node, exactly like
`check_for_ended_vote_polls`); there is no per-round swallow.

### 3.4 Replacement and cancellation (R08-14 half)

`open_readiness_round_operations` is the replacement primitive: called by the future contract
update converter with the previous round's contract id, it removes the previous pending round
subtree (`DeleteChildren`), its deadline entry and its cursor, empties the old fund to its
payer, then creates the new round, count tree and fund. `cancel_readiness_round_operations` is
the same without the create. Both are Drive-level and covered by Drive tests; the state
transition that triggers them (an authorized contract update or cancel action) is R06-05/R11-14
work and is out of scope here. Old reports cannot transfer because the report's signed bytes
include `round_id`, which includes the accepted height.

### 3.5 Missing-cache and node readiness (RUNTIME seam, no consensus)

drive-abci gains `execution/readiness/preparation_outcome.rs` (not versioned; local policy):

```rust
pub enum PreparationOutcome { Ready { report: SignablePayload }, NotYetPrepared, NodeFault(NodeFaultKind) }
pub enum NodeFaultKind { ArtifactMissing, CompilerFailed(String), AllocationFailed }
```

and `ExecutionError::NodeFault(String)` (appended). A `Ready` outcome yields the bytes the
operator signs; `NotYetPrepared` yields nothing (withheld report is the network-visible effect);
`NodeFault` is logged at error level and surfaced through the existing `Error` path so the
process stops participating (the same effect as any `Err` from a block event). No fee row, no
consensus error and no per-execution charge exists for any of the three; the fee tests in
section 6 assert the schedule contains exactly one readiness row. The service that produces
these outcomes (compile, cache lookup, restart replay) is R08-06; this task provides the type,
the classification and the test that each class maps to the documented effect, so R08-06
cannot silently turn a missing artifact into a consensus rejection.

### 3.6 Fees (allocation A15; rates provisional)

New fee group `FeeVersion.dashvm_readiness: Option<FeeDashVmReadinessVersion>` with one row,
`report_verification_fee: Credits` = **10_000** (the register's "readiness verification 10,000
processing credits per newly accepted signature"), and `FEE_VERSION4` as a struct update over
r06-01's `FEE_VERSION3` (if r06-01 has not merged when Part 2 opens, Part 2 creates the
`FEE_VERSION3` in r06-01's exact shape with `dashvm: None` omitted, and r06-01 amends; the
`fee_version_number` stays 1 either way, no storage rate changes, and the schedule is not
appended to `FEE_VERSIONS`, following r06-01's documented reasoning). `state_transition_min_fees`
gains `compilation_readiness_report: 0` in every schedule (a new row in a shared struct, so
`v1.rs` is edited with the backfill value). The membership lookup work is not separately
charged in this task (the register says "plus metered membership lookup work"; the event's
paged walk is bounded by constants, and charging it to the fund is deferred to R12-03 with the
rest of the numeric table; PR body names this).

### 3.7 Client surfaces (WIRE, CLIENT; kept minimal)

No new proto messages: the report rides `broadcastStateTransition` and `waitForStateTransitionResult`
like every transition (the DIP's "reuse broadcast/wait transport"). New `rs-sdk`
`platform::transition::compilation_readiness_report::{build, broadcast}` helper taking a
`BlsPrivateKey` signer (`state-transition-signing` feature) and returning the proof result;
`wasm-dpp2` mirror of the transition (constructor, accessors, `toBytes`, no signing UI) and
the `action_type_number` 21. Queries and proofs of rounds (a `getCompilationReadiness` RPC)
are CAP-12/CLIENT work and are not added here; the Drive `verify_*` methods exist so that RPC
is a thin wrapper later.

### 3.8 Versioning consequences (every table edit)

Protocol versions: `v15.rs`, `v16.rs` copied byte-for-byte from any sibling; `v17.rs` as a
struct update over `PLATFORM_V16` listing only this task's tables with `// changed:` comments;
`LATEST_VERSION = 17`; `PLATFORM_VERSIONS` registration. If a sibling has merged first, amend
`v17.rs` in place instead.

| Table | Base newest | Siblings claim | This task |
|---|---|---|---|
| `DRIVE_VERSION_V*` | V9 | V10 (r04-01, fix-07, fix-10) | **V11** as a struct update over V10 if merged, else over V9 with a note; slots: `vote: DRIVE_VOTE_METHOD_VERSIONS_V3`, `prefunded_specialized_balances: V2` (new `add/deduct/empty/fetch` v1 generations taking the purpose), `state_transitions: DRIVE_STATE_TRANSITION_METHOD_VERSIONS_V5` (new `compilation_readiness_report_transition` converter slot), `verify: DRIVE_VERIFY_METHOD_VERSIONS_V3` (two new voting verify slots) |
| `DRIVE_VOTE_METHOD_VERSIONS` | V2 | none | **V3**: `setup.setup_initial_vote_tree_main_structure: 1`, new `readiness: DriveVoteReadinessMethodVersions { open_round, cancel_round, insert_report, fetch_round, fetch_raw_count, fetch_reports_page, store_scan_cursor, clear_scan_cursor, record_crossing, fetch_rounds_due, activate_round, prune_reports }` all `Some(0)`, `None` backfilled in V1/V2 |
| `DRIVE_ABCI_METHOD_VERSIONS` | V10 | V11 (r06-05, fix-07, fix-10) | **V12** over V11 (or V10 with a note): `voting.run_dao_platform_events: 1`, `protocol_upgrade.perform_events_on_first_block_of_protocol_change: Some(3)`, new `readiness: DriveAbciReadinessMethodVersions { process_compilation_readiness: Some(0), membership_view: 0 }` |
| `DRIVE_ABCI_VALIDATION_VERSIONS` | V10 | none | **V11**: `state_transitions.compilation_readiness_report_state_transition` row, `compilation_readiness_report_balance_pre_check: 0`, `event_constants.{maximum_readiness_reports_to_verify_per_block: 128, maximum_readiness_rounds_to_evaluate_per_block: 8, maximum_readiness_reports_to_validate_per_block: 512, maximum_readiness_activations_per_block: 4}`; V1..V10 backfilled with a disabled row (`state: 0, transform_into_action: 0, basic_structure: None, ...`) and zero constants |
| `STATE_TRANSITION_SERIALIZATION_VERSIONS` | V3 | none | **V4** with `compilation_readiness_report_state_transition: FeatureVersionBounds { min: 0, max: 0, default: 0 }`; V1..V3 backfilled with the same bounds (the umbrella gate is `active_version_range`, not this table, matching how shielded transitions were added at 12) |
| `DPP_VOTING_VERSIONS` | V2 | none | **V3**: `readiness_round_default_structure_version: 0`, `readiness_report_record_default_structure_version: 0` |
| `SYSTEM_LIMITS` | V4 | V5 (r06-01, r06-05) | **V6** over V5: `readiness_additional_wait_min_ms: Some(120_000)`, `readiness_additional_wait_max_ms: Some(3_600_000)`; `None` backfilled in V1..V5 and both mocks |
| `FEE_VERSION` | 2 | 3 (r06-01) | **4** over 3: `dashvm_readiness: Some(FEE_DASHVM_READINESS_VERSION1)`; `None` in v1, v2, v3 and the `From<FeeVersionFieldsBeforeVersion4>` impl; `state_transition_min_fees.compilation_readiness_report: 0` in the shared v1 |
| `DRIVE_ABCI_QUERY_VERSIONS` | V3 | V4 (r06-05) | untouched |
| `PlatformVersion` struct | | r08-01 adds `dashvm` | untouched (the profile generation is read through `dashvm.map(..)` when present) |

Byte-identical: every shipped `vN` implementation module this task copies (`run_dao_platform_events/v0`,
`setup_initial_vote_tree_main_structure/v0`, `perform_events_on_first_block_of_protocol_change/v0..v2`,
prefunded `add/deduct/empty/fetch` v0), every `PLATFORM_V1..V14` except the one-line `None`
backfills required by new struct fields, all vote paths and constants, the count of root trees
(no new root key), `check_for_ended_vote_polls`, the masternode vote transition and its tests.

Consensus errors: section 3.2. `StateTransitionType` tests: `try_from(22u8).is_err()`.
`StateTransitionProofResult`: one appended variant. `NotExecutedReason`: one appended variant.
`ExecutionError`: one appended variant. `DriveError`: `ReadinessRoundMissing` appended for
corrupted-state paths.

### 3.9 Sibling coordination

Open on `v5.0-dev`: #4705 (R06-01), #4717 (R06-05), #4712 (R08-01), #4716 (R04-01), #4790
(FIX-07), #4789 (FIX-08), #4784 (FIX-10), #4718 (R14-01). Shared files: `v15.rs`, `v16.rs`
(identical), `v17.rs` (union of field overrides), `version/mod.rs`, `protocol_version.rs`,
`system_limits/mod.rs` (new field beside theirs), `fee/mod.rs` (new field beside r06-01's),
`drive_abci_method_versions/mod.rs` (new sub-struct), `codes.rs` (disjoint numbers),
`book/src/versioning/platform-version.md` (each adds a paragraph). Rebase order: whichever
lands first; this plan's generation numbers assume all siblings merge before Part 1 opens its
PR, and the implementer re-numbers downward (e.g. `DRIVE_VERSION_V11` to `V10`) only if a
sibling's table is not on the base at rebase time, keeping "one unreleased protocol version,
one table generation" (the corollary in `feedback_new_version_modules_not_flags`). The
`create_initial_state_structure` generation is not touched: the `r` tree is added inside
`setup_initial_vote_tree_main_structure` v1, which v0..v3 of `create_initial_state_structure`
reach through `create_initial_state_structure_lower_layers_operations_0`; that helper is
unversioned today and must **stay** so; the vote setup dispatcher reads its own version slot,
which is `1` only at 17, so genesis at 14 still produces the old shape (tested).

## 4. Parts

Three sequential PRs, each compiles and passes CI alone, each on `v5.0-dev`, each `Refs #4684`
and lists the provisional values of section 5. `Dash-Tasks: FIX-09` only on Part 3.

### Part 1: `feat(platform): add compilation readiness rounds, reports and funds to drive`

rs-dpp: `voting::readiness::{round, report_record, scan_cursor, payer}` models with
serialization round-trip tests; `DPP_VOTING_VERSIONS_V3`. rs-drive: the storage layout, all
twelve `readiness` methods, the `129` readiness fund purpose in prefunded v1 generations,
typed ops (`ReadinessOperationType`, prefunded fund variants), `setup_initial_vote_tree_main_structure`
v1, the two verify methods, `DRIVE_VERSION_V11`, `DRIVE_VOTE_METHOD_VERSIONS_V3`,
`DRIVE_VERIFY_METHOD_VERSIONS_V3`, `DRIVE_PREFUNDED_SPECIALIZED_METHOD_VERSIONS_V2`. rs-platform-version:
v15/v16/v17 scaffolding, `SYSTEM_LIMITS_V6` with the two wait bounds, `LATEST_VERSION = 17`.
drive-abci: `perform_events_on_first_block_of_protocol_change` v3 creating `[112, r]` on
upgrade with the genesis-versus-upgrade root-hash equality test (fix-07's pattern). Book:
`book/src/drive/compilation-readiness.md` (storage, rounds, funds) in `SUMMARY.md`.
Estimated diff: ~2,600 lines (of which ~1,100 tests, ~500 version-table backfill).

### Part 2: `feat(platform)!: add the compilation readiness report state transition`

rs-dpp: the transition (variant 21, all umbrella arms, signable bytes, `sign` helper,
`unique_identifiers`, json/value tests), the nine consensus errors and codes,
`STATE_TRANSITION_SERIALIZATION_VERSIONS_V4`, `state_transition_min_fees` row,
`FeeDashVmReadinessVersion` and `FEE_VERSION4`, `StateTransitionProofResult::VerifiedReadinessReport`.
rs-drive: the action, its transformer and converter, `prove`/`verify` arms,
`DRIVE_STATE_TRANSITION_METHOD_VERSIONS_V5`. drive-abci: the validation module (basic,
advanced-with-state, nonce, balance pre-check, state, transform), every processor-trait arm,
`ExecutionEvent` arm, CheckTx, `DRIVE_ABCI_VALIDATION_VERSIONS_V11` with the constants, the
per-block report budget with `NotExecutedReason::ReadinessReportBudgetExhausted`. wasm-dpp and
wasm-dpp2 mirrors, `rs-sdk` broadcast helper. The `!` is right: a new state transition type is
consensus-breaking. Estimated diff: ~3,400 lines (~1,500 tests).

### Part 3: `feat(drive-abci): evaluate compilation readiness at the block boundary and classify missing artifacts`

drive-abci: `ReadinessMembershipView`, `process_compilation_readiness` v0, `run_dao_platform_events`
v1, `DRIVE_ABCI_METHOD_VERSIONS_V12` with the new sub-struct, the activation hook seam,
`PreparationOutcome`/`NodeFaultKind`/`ExecutionError::NodeFault`, the test-only report factory
(`test/helpers/readiness.rs`: HPMN fixtures with operator BLS keys, a signed report builder,
an "open a round" helper), and the whole test matrix of section 6 including the strategy test.
Book: the "Evaluation, timing and node readiness" sections of the chapter. Estimated diff:
~3,000 lines (~1,900 tests).

Total ~9,000 lines. Part 1 depends on nothing; Part 2 on Part 1 (types and Drive methods);
Part 3 on Part 2 (the report to accept).

## 5. Provisional values and interpretations (every PR body repeats the ones it uses)

1. Readiness subtree key `r` under `Votes` and its inner keys `0/1/2` (A09).
2. Prefunded purpose key `129` beside `128` (A09/A20-adjacent); fund id domain string.
3. `StateTransitionType::CompilationReadinessReport = 21` and the field order (A02).
4. Operator BLS key (`Purpose::SYSTEM`, key 0 of the operator identity) as the report signer,
   with the operator identity nonce as replay protection (A10). Alternative recorded: the
   platform node Ed25519 key, rejected because its key type cannot sign a transition today.
5. Active-eligibility predicate: HPMN, not PoSe-banned, has a platform node id (A10).
6. Phase: inside `run_dao_platform_events` after ended vote polls, before ordinary transitions;
   reports accepted in block H count from H+1 (A11).
7. Constants: 128 reports verified per block, 8 rounds evaluated per block, 512 reports
   validated per block, 4 activations per block; 120 s and 3,600 s wait bounds (the latter two
   are confirmed policy, only their placement in `SystemLimits` is a choice).
8. Fee: 10,000 credits per newly accepted report from the round's fund; no membership-lookup
   charge yet (A15); sender min fee 0.
9. Consensus error codes 10605-10607, 40307-40311, 40402.
10. A report on a `Crossed` round is rejected unpaid (harmless alternative: accept and charge).
11. Cancellation refunds the fund remainder to `ReadinessPayer::Identity` by an identity
    balance credit; the contract-bucket owner arrives with FIX-08.
12. A scan cursor is invalidated by any change of `core_height` or of `n` (a stricter
    reading of "one coherent membership view" than diffing the set; cheaper and safe).
13. Activation at the deadline only removes the round and calls a hook; routing activation
    is R10-11.
14. Membership-lookup work in the event is bounded by constants and not billed.

## 6. Tests and where they live

Drive (`drive/votes/readiness/*/v0/mod.rs` and `drive/votes/readiness/tests.rs`, all
`PlatformVersion::latest()`): open, open-replaces (old subtree, deadline entry, cursor and fund
gone; new fund funded; root hash equals a fresh open), cancel refunds remainder and keeps the
`Votes` tree shape, insert report is idempotent (count stays 1, second insert reports "not
new"), raw count equals distinct keys, prune removes named keys and decrements the count,
fetch page order and `after` cursor, deadline queue range read, estimated-versus-applied fee
parity for open/insert/prune (the estimated replace lesson from memory), verify round-trips
for both verifiers, genesis at 14 has no `r` tree and at latest has it, upgrade 16 to 17
creates the same element bytes as genesis at 17.

dpp: serialization round trips for the four models and the transition, signable bytes exclude
the two signature fields, `sign` with a BLS key verifies with `NativeBlsModule`, json and value
umbrella tests, `try_from(21)` ok and `try_from(22)` err.

drive-abci transition tests (`state_transitions/compilation_readiness_report/tests.rs`, through
`process_raw_state_transitions` with a `TestPlatformBuilder` platform whose state holds
fixture HPMNs and operator identities): accepted once and charged once; **retransmission**
(same bytes twice in one block: second is `ReadinessReportAlreadyPresentError`, unpaid, fund
debited once; same bytes in a later block: same), wrong round id, wrong digest, wrong profile
(basic), non-HPMN pro_tx_hash, banned HPMN, regular masternode, operator key rotated (old
identity's report rejected, new identity's accepted), wrong key id, signature by the voting
key (purpose mismatch), stale nonce, fund exhausted (pre-check error, unpaid), report on a
crossed round, 129th report in a block is `NotExecuted` and the proposer delays it, protocol
14 rejects the transition as inactive through the decoder.

Block-event tests (`platform_events/readiness/process_compilation_readiness/v0/tests.rs`,
`fast_forward_to_block` driven): N=5 Y=3 no crossing, Y=4 crossing; N=400 needs 320; N=0
never; duplicate and wrong-round voters never inflate Y; **withheld reports** (4 of 10 nodes
never report: round stays pending across 1,000 simulated blocks, no expiry, no fee movement);
**mechanism failure** (a fixture whose preparation outcome is `NodeFault`: no report is
produced, the process error is `ExecutionError::NodeFault`, no consensus error, no fee, and the
round on other nodes behaves as withheld); membership-only crossing (a ban drops N so an
existing raw count crosses without a new report); pruning (a voter removed from the list
before the crossing is pruned and the crossing waits); paged walk across three blocks with a
membership change in the middle restarts and still crosses only on a full walk; T=30 s gives
wait 120 s, T=600 s gives 600 s, T=7,200 s gives 3,600 s; activation exactly at deadline, at
the first block after a gap, never before; membership change after crossing does not move the
deadline; replacement before activation removes the deadline; cancellation during the wait
removes it and refunds; cursor invalidation on `core_height` change; every constant bound hit
exactly (9 rounds with 8 evaluated per block, fairness cursor wraps).

Strategy test (`tests/strategy_tests/test_cases/readiness_tests.rs`): a 50-HPMN chain where 40
report over several blocks with retransmissions, one node is banned mid-way, the crossing lands,
the deadline is honoured, and app hashes match across the proposer/validator rerun. Fee
schedule test: `FEE_VERSION4` differs from `FEE_VERSION3` only in `dashvm_readiness`; exactly
one readiness row exists. Conservation: the `40` sum includes `129` funds (existing
`calculate_total_credits_balance` test extended with a funded round).

## 7. Local gate per part

```bash
cargo fmt --all
cargo clippy -p dpp -p drive -p drive-abci -p platform-version --all-features --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo check -p drive --no-default-features --features verify      # Part 1 and 2 touch src/verify
cargo test -p drive readiness
cargo test -p dpp readiness
cargo test -p drive-abci compilation_readiness                    # Parts 2 and 3
cargo test -p drive-abci --test strategy_tests readiness           # Part 3
```

Redirect every command to a file under `/tmp` and check the exit code. Use a private
`CARGO_TARGET_DIR` when another lane rebuilds `platform-version`. Never run the full drive-abci
suite locally. After editing wasm-dpp2, `cargo check -p wasm-dpp2 --target wasm32-unknown-unknown`
with the homebrew clang variables from memory.

## 8. Dependencies

`depends_on` is empty and stays empty. Reviewed inferred neighbours: R06-05 (envelope size caps;
no readiness type), R08-01 (`BundleDigest` type; carried as `[u8; 32]` here), R08-06 (the
preparation service; consumes the seam in 3.5), R04-01 (`ContractCredits` root; not used, the
fund is under `40`), FIX-08 (typed refund owners; `ReadinessPayer` has one variant until it
lands). None blocks the start. R14-04 (testnet rehearsal) is the recorded dependent and needs
Part 3 merged.

## 9. Tier

xhigh confirmed. Consensus (new transition type, new block event, new state under `Votes`),
fees (new group and row), activation timing.

## 10. Replan checklist (run at the start of each part)

1. `git log --oneline origin/v5.0-dev -20`: which siblings merged; renumber generations per 3.9.
2. Does `packages/rs-platform-version/src/version/v17.rs` exist on the base? Amend, do not add.
3. Does `FeeVersion.dashvm` exist (r06-01)? `FEE_VERSION4` over 3, else create 3 in r06-01's shape.
4. Does `PlatformVersion.dashvm` exist (r08-01)? Basic structure reads the profile from it; else
   the report's `preparation_profile` is compared with a `SystemLimits` placeholder of 0.
5. Has R06-05 part 2 added the contract create/update converter? If so, wire
   `open_readiness_round_operations` into it in Part 1 instead of leaving it test-only.
6. Codes 10605+, 40307+, 40402 still free.
