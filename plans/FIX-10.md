# FIX-10 plan: preserve native contested-index awards with validated parameters

Working artifact. Never staged, never committed. Base `v5.0-dev` at `5f1e0ccdce`
(latest protocol version 14 on this base; the DashVM 5.0 version is 17, see section 5).

## 1. Acceptance, restated

1. **Supported parameter validation.** A contract may parameterize a contested index only
   through the native `contested` declaration (`fieldMatches`, `resolution`, `description`).
   The parameters a contract supplies must be ones the native contest machinery can actually
   honour. Today nothing checks that a field match names a property of the index, that the
   matched property is a string, or that the index properties are top-level required user
   properties. Each gap has a concrete failure mode on the node (section 3.1). New rules gate
   at protocol version 17 through a versioned validator; stored contracts are never re-judged.
2. **No guest or custom-guard execution on the award.** The winner is inserted by an internal
   native action. No data trigger, creation restriction, future native guard or WASM predicate
   runs on that insert. Ordinary actions on the same collection keep their ordinary rules.
3. **Internal native authority cannot be forged.** The award is only reachable from the block
   event that finalizes a poll, and the Drive entry point it uses re-derives its authority from
   state: the poll must be live, the winner must be a registered contender of that poll, and the
   awarded document must be the stored contender document whose contest is that poll. Any other
   request is a typed rejection, never an insert. No state transition, batch action or Drive
   operation enum exposes the award.
4. **Lifecycle, atomicity and index-update rules stay enforced.** Award, finalization record and
   cleanup remain one block transaction; a poll finalizes exactly once; the awarded document is
   present in primary storage and every index of its type after the award; contested parameters
   are frozen by the existing index-definition freeze on contract update.
5. **Rule scopes are explicit.** Book chapter and code comments state which actions ordinary
   rules govern and that the award is outside every rule scope. The author SDK on the SDK-01
   branch already makes an award scope unrepresentable; this task supplies the node side.

Capability requirements: none listed. Enables CAP-16 (native contested awards parameterized,
never vetoed).

## 2. Tree facts (observed on this base, drift noted)

- Contested grammar lives in `packages/rs-dpp/src/data_contract/document_type/index/mod.rs`
  (`"contested"` arm of `Index::try_from_value_map`, lines 1311 to 1401) and the v3 document
  meta-schema (`schema/meta_schemas/document/v3/document-meta.json`, `contested` object:
  `fieldMatches[{field, regexPattern}]`, `resolution` enum `[0]`, `description`, closed
  object). Parser-level rules already present: contested requires `unique`; a `timeRange`
  index cannot be contested; indexOnly types cannot be contested. Document-type level rules in
  `try_from_schema/common/mod.rs` (lines 1014 to 1079): contested index limit (1), no contested
  index beside another unique index, not on `documentsMutable` types.
- Contest detection: `contested_vote_poll_for_document_properties_v0` and
  `prefunded_voting_balance_for_document_v0` (`document_type/methods/versioned_methods.rs`
  lines 366 and 657) iterate `field_matches` with a path lookup and require every match to
  hold. `Index::extract_values` (index/mod.rs line 793) builds the poll key with a flat map
  lookup. The contested tree walker (`insert_contested/add_contested_indices_for_contract_operations/v0`)
  reads the same properties through `get_raw_for_document_type` and defaults an absent value
  to an empty key.
- Award today: `rs-drive-abci/src/execution/platform_events/voting/award_document_to_winner/v0`
  (issue anchor line 39, unchanged) calls the generic `Drive::add_document_for_contract` with
  `override_document: false, apply: true`. Its only caller is
  `check_for_ended_vote_polls/v0` (line 279), which awards, then records the finalization
  (`keep_record_of_finished_contested_resource_vote_poll`, flips stored status to `Awarded`),
  then cleans up, all on the block transaction. Errors propagate with bare `?` up to
  `run_dao_platform_events`: an award failure is a node fault.
- `ContestedDocumentVotePollStoredInfoV0::finalize_vote_poll` already refuses a poll that is
  not `Started` (finalization once, second layer).
- Ordinary-action rules on this base are data triggers (`batch/data_triggers`, bindings list
  v2 selected at v14: DPNS `domain` create trigger requiring a preorder, reject triggers on
  replace and delete) and `creationRestrictionMode`. No guard or predicate system exists yet
  (R07-01/02 blocked). The award path runs none of them.
- Contract update: `validate_update` v1 compares parsed `Index` values by name
  (`PartialEq` includes `contested_index`), so any field-match or resolution change on an
  existing index is already rejected with `DataContractInvalidIndexDefinitionUpdateError`
  (10217). `description` is dropped at parse and the schema-compat differ strips `indices`,
  so a description-only edit is accepted (a semantic no-op).
- Version tables: `DRIVE_ABCI_METHOD_VERSIONS_V10`, `DPP_VALIDATION_VERSIONS_V5`,
  `CONTRACT_VERSIONS_V6`, `SYSTEM_LIMITS_V4`, `DRIVE_VERSION_V9` are v14's. Open sibling PRs
  #4716 (R04-01), #4705 (R06-01), #4717 (R06-05), #4718 (R14-01) each add identical
  placeholder `v15.rs`/`v16.rs` (struct updates over v14/v15) and their own `v17.rs`, set
  `LATEST_VERSION = 17`, and register V15 to V17 in `protocol_version.rs`. #4717 also adds
  `DRIVE_ABCI_METHOD_VERSIONS_V11`. None is merged as of 2026-09-16.
- Consensus error codes: data contract band ends at 10276; no sibling lane allocates in that
  band (#4717 takes 10604, v4.3-dev takes 10828). `BasicError` is positional bincode: append
  only. The legacy `packages/wasm-dpp` `from_basic_error` match is exhaustive and compiled by
  the workspace check, so a new basic error needs an arm there; `wasm-dpp2` has no per-variant
  mirror.
- All contested fixtures in the tree (DPNS v1/v2, seven drive-abci fixtures, one drive fixture,
  rs-sdk vectors) use `parentNameAndLabel` over two top-level required strings with a field
  match on `normalizedLabel`, an index property. Every new rule below accepts all of them.

## 3. Approach by crate and file

### 3.1 DPP: versioned contested parameter validation (NATIVE_VALIDATE)

New versioned class method, following the `apply_required_since` precedent:

- `packages/rs-dpp/src/data_contract/document_type/class_methods/validate_contested_index_parameters/mod.rs`
  dispatcher on `platform_version.dpp.validation.document_type.validate_contested_index_parameters`
  (`OptionalFeatureVersion`): `None` returns `Ok(())` (the behaviour every shipped version
  had), `Some(0)` dispatches to `v0`, anything else `DataContractError::Unsupported`.
  Signature: `(document_type_name: &str, index: &Index, flattened_document_properties:
  &IndexMap<String, DocumentProperty>, required_fields: &BTreeSet<String>, platform_version:
  &PlatformVersion) -> Result<(), ProtocolError>`. `platform_version` last.
- `.../validate_contested_index_parameters/v0/mod.rs`: for an index with
  `contested_index: Some(_)`, in this order, each failure returning the new consensus error:
  1. every contested index property is a top-level user property: no `.` in the name, no `$`
     prefix. Reason: the poll key (`extract_values`, flat lookup) and the contested tree path
     (`get_raw_for_document_type`) disagree for nested and system properties; today a nested
     contested property yields an empty key segment and an internal error on every create
     (maintainer note "contested index cross-check", the dotted-property case), so the
     declaration is unsupported, not merely unusual;
  2. every contested index property is in `required_fields`. Reason: the contested tree cannot
     key a null; an absent property without a field match reaches the walker as an empty key;
  3. every `fieldMatches` field names a property of that index. Reason: a match on a property
     outside the index lets two documents with equal index values take different paths (one a
     contender, one an ordinary unique insert); the later award then collides in the unique
     index and the block event fails (chain halt vector on user contracts, which have no
     trigger enforcing `label` versus `normalizedLabel` agreement);
  4. every matched property is a string (`DocumentPropertyType::String`). Reason: a regex match
     on a non-string always returns false, so the index silently degrades to a plain unique
     index and the contest can never start.
  `fieldMatches` absent (always contested) remains supported. `resolution` other than 0 and an
  invalid regex are already rejected by the parser; unchanged.
- Call site: `try_from_schema/common/mod.rs` `parse_indices`, inside the existing
  `#[cfg(feature = "validation")] if ctx.full_validation` block, right after
  `validate_index_properties(...)`. The shared core takes `&PlatformVersion` already
  (`ctx.platform_version`), so no `ParserGeneration` flag and no new parser generation. This
  is the versioned-method shape the maintainer requires for helpers reached by several
  generations. Stored contracts (`full_validation: false`) never run it.
- New consensus error `packages/rs-dpp/src/errors/consensus/basic/data_contract/contested_index_invalid_parameters_error.rs`:
  `ContestedIndexInvalidParametersError { document_type: String, index_name: String, reason:
  String }`, standard derive stack, ordering banner, `new()`, getters, `From` into
  `ConsensusError`. Appended at the tail of `BasicError`, exported from
  `basic/data_contract/mod.rs`, code **10277** in `codes.rs` (provisional, next free in the
  data contract band). Arm added to `packages/wasm-dpp/src/errors/consensus/consensus_error.rs`
  `from_basic_error` with `generic_consensus_error!`.
- Contract update: no code change; `validate_update` v1 already freezes the parameters. Tests
  pin it (section 6).

### 3.2 Drive: the native award entry point (DOCUMENTS)

New method directory
`packages/rs-drive/src/drive/document/insert_contested/award_contested_document_to_winner/{mod.rs, v0/mod.rs}`:

```
pub fn award_contested_document_to_winner(
    &self,
    vote_poll: &ContestedDocumentResourceVotePollWithContractInfo,
    winner: FinalizedContender,
    block_info: &BlockInfo,
    transaction: TransactionArg,
    platform_version: &PlatformVersion,
) -> Result<FeeResult, Error>
```

Dispatcher on `drive.methods.document.insert_contested.award_contested_document_to_winner`
(new `FeatureVersion` field on `DriveDocumentInsertContestedMethodVersions`, value 0 in
`DRIVE_DOCUMENT_METHOD_VERSIONS_V1..V4`; nothing before v17 calls it, the same shape as
`detect_ranked_mode: 0` in every table). `v0` does, in order, all on `transaction`:

1. **Poll is live.** `fetch_contested_document_vote_poll_stored_info(vote_poll, None, ...)`
   must return `Some(info)` with `info.vote_poll_status()` matching `Started(_)`. Otherwise
   `DriveError::ContestedAwardRejected("vote poll is not a started contest")`. This is the
   first "finalization once" layer (the record keeper flips the status to `Awarded` after the
   award; `finalize_vote_poll` is the second).
2. **Winner is a contender of this poll.** `ResolvedContestedDocumentVotePollDriveQuery` with
   `result_type: SingleDocumentByContender(winner.identity_id)`, `limit: Some(1)`; the returned
   contender must exist with `identity_id == winner.identity_id` and
   `serialized_document == Some(winner.serialized_document)`. Otherwise
   `ContestedAwardRejected("winner is not a contender of the vote poll")` or
   `("awarded document is not the stored contender document")`. The byte comparison binds the
   award to the state's document, not to a caller-supplied one.
3. **Document belongs to this contest.** `vote_poll.document_type()?.contested_vote_poll_for_document(&winner.document, platform_version)?`
   must equal `VotePoll::ContestedDocumentResourceVotePoll(vote_poll.into())` and
   `winner.document.owner_id() == winner.identity_id`. Otherwise
   `ContestedAwardRejected("document does not resolve to the vote poll being finalized")`.
4. **Insert through the ordinary index path.** `add_document_for_contract_apply_and_add_to_operations`
   with `DocumentAndSerialization((document, serialized_document, None))`, `owner_id:
   Some(identity_id)`, `override_document: false`, `document_is_unique_for_document_type_in_batch:
   true`, `stateful: true`; then `Drive::calculate_fee` on the accumulated operations (returned,
   not charged: the award has no payer). Byte-identical writes to what v0 of the ABCI event
   produces on a legitimate award: same document info variant, same flags, same insert path.

No estimation (`*_operations`) variant: the award is never priced against a payer. New
`DriveError::ContestedAwardRejected(String)` appended to `DriveError` (not serialized, no
append marker, still appended). No new Drive-level table version is needed; the gate is the
ABCI event version below.

Not exposed anywhere else: no `DocumentOperationType` variant, no `BatchedTransitionAction`
or `DocumentTransitionAction` variant, no `StateTransitionType`. A test in the dispatcher
`mod.rs` asserts the method is not reachable through `DocumentOperationType` by exhaustively
listing that enum's variants (compile-time exhaustiveness through a `match`), so a future
host adapter cannot add a guest-reachable award without touching the test.

### 3.3 Drive ABCI: award event generation 1 (NATIVE_SYSTEM)

`packages/rs-drive-abci/src/execution/platform_events/voting/award_document_to_winner/v1/mod.rs`
(copy of v0, then change): calls `self.drive.award_contested_document_to_winner(vote_poll,
contender, block_info, transaction, platform_version)?` and discards the fee. Dispatcher gains
the `1 =>` arm and `known_versions: vec![0, 1]`. v0 stays byte-identical.

`check_for_ended_vote_polls/v0` is unchanged: it already calls the dispatcher. Award, record and
cleanup remain one transaction; nothing about ordering moves.

### 3.4 Platform version tables

- `dpp_versions/dpp_validation_versions/mod.rs`: `DocumentTypeValidationVersions` gains
  `validate_contested_index_parameters: OptionalFeatureVersion` with a doc comment naming the
  method. Backfill `v1.rs`, `v2.rs`, `v3.rs` literals with `None` (v4 and v5 are struct
  updates and inherit; mocks use V2, no edit). New `v6.rs`:
  `DPP_VALIDATION_VERSIONS_V6 = { document_type: { validate_contested_index_parameters: Some(0),
  ..V5.document_type }, ..V5 }`.
- `drive_versions/drive_document_method_versions/mod.rs`: `DriveDocumentInsertContestedMethodVersions`
  gains `award_contested_document_to_winner: FeatureVersion`; `v1.rs` to `v4.rs` literals get
  `0`. The `historical_method_table_freeze` test in that module is checked for a literal that
  needs the field (it pins shipped tables; a new all-zero slot is the accepted shape).
- `drive_abci_versions/drive_abci_method_versions/v11.rs`: `DRIVE_ABCI_METHOD_VERSIONS_V11`
  with `voting: DriveAbciVotingMethodVersions { award_document_to_winner: 1, ..V10.voting },
  ..V10`. If #4717 merges first, amend its V11 in place (one unreleased protocol version, one
  table generation); if this lands first, #4717 amends.
- `version/v15.rs`, `v16.rs`: the same placeholder files the sibling lanes carry (byte-identical
  across #4705, #4716, #4717; verified with diff), so an add/add conflict resolves by taking
  either side. `version/v17.rs`: `PLATFORM_V17 = { protocol_version: 17, drive_abci:
  DriveAbciVersion { methods: DRIVE_ABCI_METHOD_VERSIONS_V11, ..PLATFORM_V16.drive_abci }, dpp:
  DPPVersion { validation: DPP_VALIDATION_VERSIONS_V6, ..PLATFORM_V16.dpp }, ..PLATFORM_V16 }`
  with a doc comment listing this task's two changes; on forward merge the sibling changes are
  added to the same file. `version/mod.rs`: `pub mod v15/v16/v17`, `LATEST_VERSION =
  PROTOCOL_VERSION_17`. `protocol_version.rs`: register V15 to V17, `LATEST_PLATFORM_VERSION =
  &PLATFORM_V17`.
- Protocol version 17 for 5.0 is the provisional register number (15 for 4.3, 16 for 4.4).
- No `SystemLimits`, fee schedule, `CONTRACT_VERSIONS`, meta-schema, proto or SDK change.

### 3.5 Book

New chapter `book/src/drive/contested-resources.md` (linked from `SUMMARY.md` after
Index-Only Document Types, and the "out of scope" pointer in `drive/indexes.md` updated to it):
the contested declaration and its supported parameters (the four rules, with their protocol
version), rule scopes (ordinary document actions are governed by ordinary validation, data
triggers and, when they arrive, native guards and predicates; the award is a native block
event governed only by the native contested rules), the award authority checks, the
finalization-once and atomicity facts, and the lifecycle note (freeze and wipe are native
lifecycle rules, never a veto over a poll outcome; they arrive with R07-06 and FIX-07).

## 4. What stays byte-identical

- `award_document_to_winner/v0`, `check_for_ended_vote_polls/v0`, every `insert_contested`
  v0 module, `add_document_for_contract*` v0, `Index::try_from_value_map`, the v3 meta-schema,
  `try_from_schema` generations 0 to 3 (the shared core gains one versioned call that is a
  no-op below v17), `validate_update` v0/v1, all `DRIVE_ABCI_*`, `DPP_*`, `CONTRACT_*` tables
  V1 to V10/V5/V6 except the backfilled `None`/`0` slots, mocks.
- State roots at protocol versions 14 to 16: unchanged (no write path changes below v17; at
  v17 a legitimate award writes exactly what v0 wrote).
- Fees: unchanged. The award has no payer; contract registration cost does not depend on the
  new validation.

## 5. Versioning consequences (summary)

| Surface | Change |
| --- | --- |
| Protocol versions | placeholders 15, 16; 17 selects `DPP_VALIDATION_VERSIONS_V6` and `DRIVE_ABCI_METHOD_VERSIONS_V11` |
| DPP validation table | new `validate_contested_index_parameters: OptionalFeatureVersion`, `None` on V1 to V5, `Some(0)` on V6 |
| Drive document method table | new `insert_contested.award_contested_document_to_winner: FeatureVersion = 0` on V1 to V4 |
| Drive ABCI method table | V11 `voting.award_document_to_winner: 1` |
| Consensus errors | `ContestedIndexInvalidParametersError` = 10277 (basic, data contract band) |
| Drive errors | `DriveError::ContestedAwardRejected(String)` |
| Proto, SDKs, wasm-dpp2 | none; `wasm-dpp` gets the exhaustive-match arm |
| Fees, limits | none |

Commit title: `feat(platform)!: validate contested index parameters and bind the native award to its poll` (consensus-breaking: a contract create or update accepted at 14 to 16 can be rejected at 17). `Dash-Tasks: FIX-10` in the PR body; `Refs #4685`.

## 6. Tests and where they live

rs-dpp
- `validate_contested_index_parameters/v0/mod.rs` tests (latest version): DPNS-shaped index
  accepted; always-contested (no `fieldMatches`) accepted; nested contested property rejected;
  `$ownerId` contested property rejected; optional contested property rejected; field match on
  a non-index property rejected; field match on an integer index property rejected; each
  rejection carries the index name and reason.
- `validate_contested_index_parameters/mod.rs` dispatcher tests: the same invalid schemas parse
  under full validation at `PlatformVersion::get(14)` (table `None`) and are rejected at
  `latest()`; the invalid schemas parse at `latest()` without full validation (stored-contract
  path never re-judges).
- `validate_update/v1/mod.rs`: changed `regexPattern`, added field match, changed matched
  field each rejected as "changed index"; identical contested declaration accepted.

rs-drive
- `award_contested_document_to_winner/v0/mod.rs` tests on
  `dpns-contract-contested-unique-index.json` with two contenders inserted through
  `add_contested_document_for_contract` (stored info included): award to a contender succeeds
  and the document is fetchable by id, through the unique `parentNameAndLabel` index and through
  the `identityId` index (atomic index effects); award to a non-contender rejected; award with a
  tampered serialized document rejected; award whose document resolves to a different poll
  rejected; award when stored info is `Awarded` or `Locked` or absent rejected; no operation is
  applied on any rejection (root hash unchanged).
- `award_contested_document_to_winner/mod.rs`: exhaustiveness test over `DocumentOperationType`
  and `DocumentTransitionAction` documenting that no variant maps to the award.

rs-drive-abci
- `award_document_to_winner/mod.rs` tests (through the dispatcher at `latest()`): forged award
  (non-contender identity, or a contender's document rewritten) returns `Err`, and the poll
  state, contenders and end-date entry are untouched; the same call at
  `PlatformVersion::get(14)` still routes to v0 (pinned behaviour: inserts without the checks).
- `masternode_vote/mod.rs` `document_distribution` module, new test: contest on the DPNS system
  contract with document triggers enabled (the default); both contenders delete their preorder
  documents before the poll ends (so a create-scope rule re-run would reject); votes; finalize
  through `check_for_ended_vote_polls`; the award succeeds (no create rule runs on the award);
  the winner's replace and delete of the awarded domain are rejected by the ordinary reject
  trigger (ordinary rules still enforced); the finished vote state shows exactly one finalized
  event, `Awarded(winner)`; a second `check_for_ended_vote_polls` at a later time finds nothing
  to award (finalization once, end-date entry cleaned).
- `data_contract_create/mod.rs`: a contract with a field match on a non-index property is
  accepted at 14 (`with_initial_protocol_version(14)`) and rejected at `latest()` with
  `ContestedIndexInvalidParametersError`, through `process_raw_state_transitions`
  (`Network::Mainnet`, since Testnet skips contested structure validation before epoch 2080).
- `data_contract_update/mod.rs`: an update changing the contested `regexPattern` is rejected
  with `DataContractInvalidIndexDefinitionUpdateError`; a description-only edit is accepted.
- Existing coverage relied on, not rewritten: `test_document_distribution*`,
  `test_document_distribution_does_not_affect_other_contests` (user-registered contested
  contract), strategy `voting_tests.rs`.

Local gate: `cargo fmt --all`; `cargo clippy -p dpp -p drive -p drive-abci -p platform-version
--all-features --all-targets -- -D warnings`; `cargo check --workspace --all-targets`; `cargo
check -p drive --no-default-features --features verify` (the new Drive module is `server`
only, this proves it); `cargo test -p dpp validate_contested_index_parameters`, `cargo test -p
dpp validate_update`, `cargo test -p drive award_contested_document`, `cargo test -p drive-abci
award_document_to_winner`, `cargo test -p drive-abci document_distribution`, `cargo test -p
drive-abci data_contract_creation_with_contested`. Outputs to files, exit codes checked.

## 7. Estimated diff

About 2,000 lines: DPP validator, error and tests 450; version tables and v15 to v17 files
250; Drive method and tests 600; Drive ABCI v1 and tests 550; wasm-dpp arm 5; book 130.
One PR; the two surfaces (registration validation, award authority) are small and share the
version scaffolding, so a split would only add stacking cost.

## 8. Decisions and provisional values (go in the PR body)

- Protocol version 17 as the 5.0 version, 15 and 16 as placeholders: provisional register
  values shared with the sibling 5.0 PRs.
- Error code 10277: provisional, next free in the data contract band.
- The four parameter rules (top-level user properties, required, field match on an index
  property, matched property is a string) are this task's reading of "supported native
  declarations"; each is justified by a failure the node exhibits today. Always-contested
  declarations remain supported.
- New rules apply only to contract create and update validated at protocol 17 or later; stored
  contracts and pre-17 history are untouched (validation-only, `full_validation` gated).
- Award authority is state-derived (live poll, registered contender, matching document bytes,
  document resolves to the poll) rather than a sealed type: crate visibility cannot tell a
  future host adapter apart from the block executor, so the check must hold for any caller.
  The method is also kept off every guest-reachable enum, with a test.
- Guest-guard vectors (trap, reject, infinite loop never invoked for an award) are delivered
  in their native form now (a create-scope data trigger that would reject is not run on the
  award); R07-10 re-runs them against the guard evaluator once R07-01/02/05 land. Freeze and
  wipe boundaries are R07-06 and FIX-07 work; this PR documents the rule and does not stub them.
- A description-only contested edit stays accepted on update (dropped at parse, no semantic
  effect). Field-match and resolution edits stay rejected by the existing index freeze.
- `LazyRegex::is_match` keeps its parse-time-validated `expect`; regexes are compiled at
  registration under validation and stored contracts were validated at registration.

## 9. Dependencies

`depends_on` is empty and stays empty. Nothing here needs R07-01/02/05 (no guard code exists to
integrate; the award entry point is what those tasks must route around). No `blocked_on`.
