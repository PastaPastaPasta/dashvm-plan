# FIX-11 plan: public-method compatibility and warning behavior

Working artifact. Never staged, never committed. Delete when the task ships.

Base `v5.0-dev` at `5f1e0ccdce` (identical to the issue's source anchor, so no line drift in
the anchors the issue cites; latest protocol version on this base is 14, the DashVM 5.0 version
is 17 on every open sibling PR). Branch `dashvm/fix-11`. Two sequential parts, both on
`v5.0-dev`, part 2 stacked on part 1. Tier stays `xhigh`: the work adds consensus error codes,
protocol version tables and the pure rules that future state validation will dispatch on.

## 1. Acceptance in my words

1. **Stable method ABI.** A public method has a canonical, bounded, versioned signature
   descriptor (name, receiver, read-only flag, parameter types, return type) and a
   domain-separated digest of that signature. The digest is a pure function of the descriptor
   and survives every Rust-side refactor (module moves, impl blocks, declaration order,
   parameter renames). It is distinct from the numeric method ID the ABI allocation (register
   entry A07, task R08-04) will assign.
2. **Compatibility report.** Given the method tables of two executable versions, a
   deterministic report lists added, removed, signature-changed and parameter-renamed methods
   and says whether every method callers of the old version could call still exists with the
   same signature. The report, its `Display` text and its documentation state that signature
   compatibility does not prove semantic equivalence and tell callers to bound transfers,
   validate return values and rely on whole-transition rollback.
3. **No protocol minimum warning period.** No table, limit or rule imposes a minimum notice
   before deprecation, retirement or upgrade. The only notices enforced are the ones a contract
   declared itself.
4. **Contract-promised notice.** A contract may announce that a version stays selectable until
   at least a consensus time, or that no new version activates before a consensus time. Once
   announced a promise may be kept or moved later, never earlier. Retiring a version before its
   promised time is rejected; activating before the promised upgrade time is refused by a pure
   check the activation boundary (R08-14) will call.
5. **Deprecation is a warning.** A deprecated version stays selectable by direct callers and
   stays routable as latest if it is the latest; the resolution carries a typed warning that
   clients surface. Nothing in this task disables execution because of deprecation.
6. **Declared authority retires versions.** Deprecate, restore, promise and retire are
   authorized by the contract's declared executable update policy (an `AuthorizedActionTakers`
   value plus a self-upgrade flag). A new active version never changes the status of older
   versions; retirement is a status, canonical code is never deleted by any rule here.
7. **Version selection.** A direct caller may name a version; it must exist and be supported or
   deprecated. A direct caller that names nothing, every cross-contract call and every scheduled
   job resolve the latest active version. Cross-contract and scheduled origins cannot pin a
   version at all; the rule refuses an explicit selection from them.
8. **Clients show status and changes.** The Rust SDK exposes the lifecycle status, the
   resolution warnings and the compatibility report with the semantic disclaimer, and never
   auto-pins an old version.

Capability requirements: none listed. Enables SDK-04 (version-aware clients). Refines
R08-03 (method declarations on contracts) and R11-14 (the transitions, storage and routing that
apply these rules).

## 2. Tree facts and drift (observed on this base and the open siblings)

- No DashVM code exists on `v5.0-dev`: none of `rs-drive-contracts` (CALLS),
  `rs-dash-contract-build` (BUILD), `rs-dashvm-abi`, `rs-dashvm-validation` or
  `rs-dash-sdk-contract` is in `Cargo.toml` (48 members, none DashVM). `rs-dashvm-validation`
  lives on `dashvm/r08-01` (PR #4712, base `v5.0-dev`, not merged); `rs-dash-sdk-contract` lives
  on `dashvm/sdk-01` (PR #4719, base `v4.3-dev`, not merged, will reach `v5.0-dev` only through
  maintainer forward merges). `rs-sdk` (CLIENT) exists: `packages/rs-sdk/src/platform.rs`
  declares the platform modules, `platform/transition/put_settings.rs` is the settings
  precedent, no `smart_contract` module yet.
- Method identity on the SDK-01 branch: `MethodEntry { name: MethodName, module, export,
  receiver: Receiver::{None, Ref, Mut}, takes_document_id, read_only, params: Vec<ParamSpec>,
  returns: ValueType }` with `ValueType::{Unit, Bool, Integer(IntegerWidth), F64, String{max_chars},
  Bytes{max_len}, Identifier, DocumentId, Option, List{max_len, item}, Struct(fields)}`. The
  crate says the wire encoding and numeric IDs belong to the ABI work. Part 2 mirrors this
  vocabulary one to one so the build-tool adapter is mechanical.
- Version selection has no home yet: `rs-dashvm-validation` marks an export as an entry
  candidate by signature only (`abi_validation.rs`, `is_entry_candidate`); nothing resolves a
  contract version.
- Protocol tables: `packages/rs-platform-version/src/version/dpp_versions/dpp_contract_versions/mod.rs`
  defines `DPPContractVersions` (literal in `v1.rs` to `v6.rs`, mocks reference
  `CONTRACT_VERSIONS_V1` by name so they need no edit). `v14.rs` selects `CONTRACT_VERSIONS_V6`.
  `PlatformVersion` has no `dashvm` field on this base; the `dashvm: Option<DashVmVersion>`
  field is R08-01's and arrives with that merge.
- Placeholders: every open 5.0 sibling carries byte-identical `v15.rs`/`v16.rs` (struct updates
  over the predecessor) and its own `v17.rs` as a struct update over `PLATFORM_V16`, sets
  `LATEST_VERSION = PROTOCOL_VERSION_17` in `version/mod.rs` and registers V15 to V17 in
  `protocol_version.rs` (`PLATFORM_VERSIONS`, `LATEST_PLATFORM_VERSION`). Copy the placeholders
  from `origin/dashvm/r08-01` verbatim.
- Authority model to reuse: `AuthorizedActionTakers::{NoOne, ContractOwner, Identity, MainGroup,
  Group}` with `allowed_for_action_taker(owner, main_group, groups, action_taker, goal)` in
  `packages/rs-dpp/src/data_contract/change_control_rules/authorized_action_takers.rs`;
  `ActionTaker::{SingleIdentity, SpecifiedIdentities}` and `ActionGoal` in
  `packages/rs-dpp/src/group/action_taker.rs`. `DataContract` exposes `owner_id()` (v0
  accessors) and `groups()` (v1 accessors).
- Consensus errors: state band `40000-40099` "Data contract" ends at `40009`
  (`InvalidTokenPositionStateError`), so `40010` is next. Basic band data contract ends at
  `10276` on the base; the open contested-index PR (FIX-10) claims `10277`, so this task takes
  `10278` onward and leaves `10277` alone. `StateError` in
  `errors/consensus/state/state_error.rs` carries the "DO NOT CHANGE ORDER" banner: append only.
  `wasm-dpp/src/errors/consensus/consensus_error.rs` matches `StateError` and `BasicError`
  exhaustively (`generic_consensus_error!` arms, 178 uses), so every new variant needs an arm or
  the JS build breaks. `wasm-dpp2/src/consensus_error.rs` branches on codes only; no edit.
  Precedent for an error carrying an enum field: `UnauthorizedTokenActionError` carries
  `AuthorizedActionTakers`. Precedent for an error with an `action: String`:
  `DataContractUpdateActionNotAllowedError` (40004), reused here for authority failures.
- Versioned type pattern: `Group { V0(GroupV0) }` with `#[serde(tag = "$formatVersion")]`,
  `#[platform_serialize(unversioned)]`, `JsonConvertible`/`ValueConvertible` behind
  `json-conversion`/`value-conversion`, accessor traits on the enum;
  `docs/json-value-conversion-canonical-pattern.md` has the round-trip test template.
- Validation result API: `SimpleConsensusValidationResult` (`validation/validation_result/mod.rs`)
  with `new`, `new_with_error`, `add_error`, `merge`. Not feature gated.
- Dispatcher errors in dpp: `ProtocolError::UnknownVersionMismatch { method, known_versions,
  received }` and `ProtocolError::UnknownVersionError(String)`; dpp has no `VersionNotActive`
  variant (drive does).
- Hashing: `dpp::util::hash::hash_single` (SHA-256) exists; `sha2 = 0.10` is already a dpp
  dependency.
- Book: `book/src/SUMMARY.md` has no DashVM section on this base; SDK-01 adds `# DashVM` with
  `dashvm/contract-declarations.md` before `# Appendix` on `v4.3-dev`. This task adds the same
  heading at the same position so the forward merge yields one section.
  `book/src/error-handling/error-codes.md` line 107 lists the `40000-40009` data contract row.
- Sibling `v17.rs` contents (for conflict awareness): R06-01 flips `fee_version`/`system_limits`;
  R06-05 flips `drive_abci`, `consensus`, `system_limits`; R08-01 sets `dashvm`; FIX-07 and
  FIX-10 flip drive/dpp validation tables; R04-01 flips `drive`. None touches
  `dpp.contract_versions`, so this task's `v17.rs` line merges without a semantic clash (the
  add/add conflict on the file itself is resolved by keeping both struct-update lines).

## 3. Design decisions

D1. **Home is DPP, not the missing crates.** The conventions put a protocol type, its wire
shape and its pure-data invariants in `rs-dpp`; the crate layout gives `rs-dpp` "typed native
contract configuration, lifecycle messages, stateless validation" and forbids DPP from importing
the author SDK. The lifecycle policy, notice rules and selection rule decide consensus outcomes
and must be computable by node, tooling and client from one implementation, so they live in
`packages/rs-dpp/src/data_contract/smart_contract/`. CALLS (`rs-drive-contracts`, R10-11/R11-14)
will call `resolve_executable_version`; BUILD (`rs-dash-contract-build`, R13-06/SDK-04) will map
the SDK-01 manifest onto `MethodDescriptor` and call the report; CLIENT (`rs-sdk`) re-exports
and surfaces warnings now. Nothing here waits for a crate that is not on the base.

D2. **Versioning through `DPPContractVersions.smart_contract: Option<SmartContractVersions>`.**
`None` on `CONTRACT_VERSIONS_V1..V6` (feature absent, exact pre-feature behaviour), `Some` on a
new `CONTRACT_VERSIONS_V7` selected only by `PLATFORM_V17`. Inside, plain `FeatureVersion`
slots (`lifecycle_rules: 0`, `version_selection: 0`, and in part 2 `method_descriptor: 0`) plus
the method-descriptor limits (part 2). This mirrors R08-01's `dashvm: Option<DashVmVersion>`
(one `Option` says "absent", the generations inside are plain) and keeps the table edit to six
backfills plus one new file. Dispatchers: `Some(0) => v0`, `Some(n) => UnknownVersionMismatch`,
`None => Err(ProtocolError::UnknownVersionError("... is not active at protocol version N"))`.
The `None` arm is an internal error on purpose: a transition that could reach these rules is
itself gated by `StateTransitionNotActiveError` before the rules run, so reaching `None` means
the caller is wrong, not the user.

D3. **Lifecycle model.** Per contract an `ExecutableVersionTable { V0 }` holds
`versions: BTreeMap<ExecutableVersion, VersionLifecycle>`, `latest_active: Option<ExecutableVersion>`
and `next_activation_not_before: Option<TimestampMillis>`. Per version
`VersionLifecycleV0 { status: SupportStatus, supported_until_at_least: Option<TimestampMillis> }`
with `SupportStatus::{Supported, Deprecated { since }, Unsupported { since }}`. All times are
consensus block times in milliseconds (DVM-03 uses consensus time, never heights or local
clocks). `ExecutableVersion` is a `u32` alias.

D4. **Actions and rules (all pure, all in one versioned entry point).**
`LifecycleAction::{Deprecate { version, supported_until_at_least: Option<_> }, Restore { version },
PromiseSupport { version, supported_until_at_least }, Retire { version },
PromiseUpgradeNotice { next_activation_not_before }}`.
`check_lifecycle_action(contract_owner_id, main_group, groups, policy, table, action, actor,
block_info, platform_version) -> Result<SimpleConsensusValidationResult, ProtocolError>` and
`apply_lifecycle_action(table, action, block_time) -> Result<ExecutableVersionTable, ProtocolError>`
(the caller checks first; `apply` returns `ProtocolError::CorruptedCodeExecution` if asked to
apply an action `check` would have refused, never panics). Rules:
- Authority first: `actor` is `LifecycleActor::Identities(ActionTaker)` or `LifecycleActor::Contract`.
  Identities pass through `policy.authorized.allowed_for_action_taker(.., ActionGoal::ActionCompletion)`;
  the contract passes iff `policy.allow_self_upgrade`. Failure: `DataContractUpdateActionNotAllowedError`
  (40004, reused) with the action name.
- Deprecate: from Supported or Deprecated (repeating a deprecation is allowed so a promise can be
  attached later); from Unsupported or unknown: `ExecutableVersionLifecycleTransitionInvalidError`.
  A supplied promise must be `>=` any existing promise, else `ExecutableVersionNoticeShortenedError`.
  Sets `Deprecated { since: block_time }` (keeps the original `since` when already deprecated).
- Restore: Deprecated to Supported only; the promise is untouched (a promise never disappears).
- PromiseSupport: Supported or Deprecated; new `>=` existing else NoticeShortened.
- Retire: Supported or Deprecated, not the latest active version (retiring the routing target
  would leave latest routing with nothing; freeze and wipe are the tools for that and belong to
  governance), and `block_time >= supported_until_at_least` when a promise exists, else
  `ExecutableVersionNoticeNotElapsedError`. Sets `Unsupported { since: block_time }`.
  Unsupported is terminal: no action restores it (provisional, section 8).
- PromiseUpgradeNotice: new `>=` existing else NoticeShortened. Consumed by activation.
- No rule reads a protocol minimum, a maximum or a default notice. A promise may lie
  arbitrarily far in the future; that makes the version un-retirable, which is the contract's
  own binding choice (provisional, section 8).

D5. **Activation helpers (pure, wired by R08-14).**
`ExecutableVersionTable::activation_permitted_at(block_time) -> Result<(), ExecutableVersionNoticeNotElapsedError>`
refuses activation before `next_activation_not_before`. `activate(version, block_time)` inserts
the version as `Supported`, sets `latest_active`, clears `next_activation_not_before`, and
touches no other version's status. The test "activating v3 leaves v1 supported and v2 deprecated"
pins "a new version does not automatically retire previous versions".

D6. **Selection.** `VersionSelection::{Latest, Explicit(ExecutableVersion)}`,
`CallOrigin::{Direct, CrossContract, Scheduled}`,
`resolve_executable_version(origin, selection, table, platform_version)
-> Result<Result<ResolvedVersion, VersionResolutionError>, ProtocolError>`, where
`ResolvedVersion { version, warnings: Vec<VersionWarning> }` and
`VersionWarning::Deprecated { version, since, supported_until_at_least }`.
`VersionResolutionError::{ExplicitSelectionNotAllowed { origin, version }, NotFound { version },
Unsupported { version, since }, NoActiveVersion}`; the last three convert into the consensus
state errors below (the direct-call transition path), the first is deliberately not a consensus
error: no transition can carry a cross-contract or scheduled pin, it is a host-side rejection for
guest code (DVM-01 `InactiveVersion` family, taxonomy owned by R12-07).

D7. **Method descriptor and digest (part 2).** `MethodDescriptor { V0(MethodDescriptorV0 {
name, receiver: MethodReceiver::{Free, Ref { collection }, Mut { collection }}, read_only,
params: Vec<MethodParam { name, ty: MethodWireType }>, returns: MethodWireType }) }` with
`MethodWireType` mirroring SDK-01's `ValueType` variant for variant. `signature_digest()` is
SHA-256 over `b"dashvm:method-signature:v0"` followed by the canonical bincode of a
`MethodSignatureV0` projection that drops parameter names (names are documentation for
generated clients, arguments travel positionally; renaming is reported, not breaking).
`validate_structure(&self, platform_version)` enforces the limits of D2 and returns
`SmartContractMethodDescriptorInvalidError` (basic, 10278) with a reason.

D8. **Compatibility report (part 2).** `MethodTable { V0 }` (sorted by name, unique names;
constructor rejects duplicates) and `compatibility_report(from: &MethodTable, to: &MethodTable)
-> CompatibilityReport { V0 }` listing `added`, `removed`, `changed { name, before, after,
differences: Vec<SignatureDifference> }`, `renamed_parameters { name, positions }` and
`unchanged` names, with `signature_compatible()` true iff `removed` and `changed` are empty.
Not protocol-versioned by a table slot: it is a tooling and client computation over versioned
inputs, versioned by its own struct generation. `Display` ends with the fixed disclaimer
sentence; the type's docs and the book say the same.

D9. **Client surface (part 2).** `packages/rs-sdk/src/platform/smart_contract/mod.rs`
re-exports the DPP lifecycle, selection and compatibility types, adds
`ResolvedVersion::log_warnings()` (one `tracing::warn!` per warning) and
`CompatibilityReport::describe()` (the `Display` text), and documents that the SDK never selects
an old version on the caller's behalf and that a compatible report is not a semantic guarantee.
Queries, builders and broadcast for calls and lifecycle actions are SDK-04 and R11-14.

D10. **Two parts.** Part 1 is the consensus-facing definition (lifecycle, notice, selection,
errors, tables). Part 2 is the tooling and client definition (descriptor, digest, report, SDK).
They are independent surfaces with different reviewers' attention; part 2 stacks on part 1 only
so the SDK module can re-export both.

## 4. Part 1: executable version lifecycle, promised notice and version selection

Base `v5.0-dev`, branch `dashvm/fix-11`. PR title (no `!`: a node at 17 behaves exactly like
one at 16, no dispatching path reaches the new rules yet):
`feat(dpp): define executable version lifecycle, promised notice and version selection`
(scope `dpp`; the platform-version table edit is the conventional companion, as in the
contested-index PR; confirm the scope allowlist in `.github/workflows/pr.yml`).

### 4.1 `packages/rs-dpp/src/data_contract/smart_contract/`

- `mod.rs`: module docs (what this is, what is deferred to R08-03/R11-14/R08-14, the "no
  protocol minimum warning period" statement), `pub type ExecutableVersion = u32;`, `pub mod
  update_policy; pub mod lifecycle; pub mod selection;`. Registered from
  `data_contract/mod.rs` as `pub mod smart_contract;`.
- `update_policy/mod.rs` + `v0/mod.rs`: `ExecutableUpdatePolicy { V0(ExecutableUpdatePolicyV0 {
  authorized: AuthorizedActionTakers, allow_self_upgrade: bool }) }`, accessor trait
  `ExecutableUpdatePolicyV0Getters`, `LifecycleActor::{Identities(ActionTaker), Contract}`,
  `fn allows(&self, contract_owner_id, main_group, groups, actor) -> bool`. Derive stack as
  `Group`. Default policy: `ContractOwner`, `allow_self_upgrade: false`.
- `lifecycle/mod.rs` + `v0/mod.rs`: `SupportStatus`, `VersionLifecycle { V0 }`,
  `ExecutableVersionTable { V0 }` with getters/setters traits, `LifecycleAction`, `activate`,
  `activation_permitted_at`, `is_selectable(version)`, `latest_active()`. Invariant checks in
  a `validate_invariants()` used by tests and by `apply` (latest is present and not
  unsupported).
- `lifecycle/rules/mod.rs` (dispatcher `check_lifecycle_action` and `apply_lifecycle_action`
  on `platform_version.dpp.contract_versions.smart_contract.lifecycle_rules`) +
  `rules/v0/mod.rs` (`pub(super) fn check_lifecycle_action_v0`, `apply_lifecycle_action_v0`,
  `#[inline(always)]`, doc comments with `# Parameters` / `# Returns`).
- `selection/mod.rs` (dispatcher on `version_selection`) + `v0/mod.rs`
  (`resolve_executable_version_v0`), plus `VersionSelection`, `CallOrigin`, `ResolvedVersion`,
  `VersionWarning`, `VersionResolutionError` and its `From<VersionResolutionError> for
  ConsensusError` for the three state-error cases (`TryFrom` returning the
  `ExplicitSelectionNotAllowed` case back, since that one has no consensus mapping).
- `platform_version` is the last parameter everywhere; `block_info` sits before it.

### 4.2 Consensus errors (`packages/rs-dpp/src/errors/consensus/state/data_contract/`)

New files, standard derive stack, private fields, `new()`, getters, ordering banner, `From` into
`ConsensusError`, appended to `StateError` at the end of the enum, codes in `codes.rs`:

| Code | Error | Fields |
| --- | --- | --- |
| 40010 | `ExecutableVersionNotFoundError` | `data_contract_id`, `version` |
| 40011 | `ExecutableVersionUnsupportedError` | `data_contract_id`, `version`, `unsupported_since` |
| 40012 | `NoActiveExecutableVersionError` | `data_contract_id` |
| 40013 | `ExecutableVersionNoticeShortenedError` | `data_contract_id`, `version: Option<_>` (none for the upgrade notice), `promised`, `requested` |
| 40014 | `ExecutableVersionNoticeNotElapsedError` | `data_contract_id`, `version: Option<_>`, `promised`, `block_time` |
| 40015 | `ExecutableVersionLifecycleTransitionInvalidError` | `data_contract_id`, `version`, `status: SupportStatus`, `action: String` |

Authority failures reuse `DataContractUpdateActionNotAllowedError` (40004) with action names
`deprecateExecutableVersion`, `restoreExecutableVersion`, `promiseExecutableSupport`,
`retireExecutableVersion`, `promiseUpgradeNotice`. `wasm-dpp/src/errors/consensus/consensus_error.rs`
gets six `generic_consensus_error!` arms and the import line. `book/src/error-handling/error-codes.md`
row `40000-40009` becomes `40000-40015` with the new names. `SupportStatus` therefore needs
`Encode/Decode` and `PlatformSerialize`, which it has anyway.

### 4.3 Version tables (`packages/rs-platform-version`)

- `dpp_versions/dpp_contract_versions/mod.rs`: add `pub smart_contract: Option<SmartContractVersions>`
  to `DPPContractVersions` (doc: `None` before smart contracts) and
  `pub struct SmartContractVersions { pub lifecycle_rules: FeatureVersion, pub version_selection: FeatureVersion }`
  (part 2 appends `method_descriptor` and `limits`). Add `pub mod v7;`.
- `v1.rs` to `v6.rs`: `smart_contract: None,` backfilled (shipped tables stay
  behaviour-preserving).
- `v7.rs`: `CONTRACT_VERSIONS_V7 = DPPContractVersions { smart_contract: Some(SMART_CONTRACT_VERSIONS_V1), ..CONTRACT_VERSIONS_V6 }`
  with `pub const SMART_CONTRACT_VERSIONS_V1` (`lifecycle_rules: 0, version_selection: 0`) and a
  doc comment in the style of `v6.rs`.
- `version/v15.rs`, `v16.rs`: byte-identical copies of `origin/dashvm/r08-01`'s placeholders.
- `version/v17.rs`: `PLATFORM_V17 = PlatformVersion { protocol_version: PROTOCOL_VERSION_17,
  dpp: DPPVersion { contract_versions: CONTRACT_VERSIONS_V7, ..PLATFORM_V16.dpp }, ..PLATFORM_V16 }`
  with the shared doc paragraph (provisional numbering 15/16/17) and one bullet for this table.
- `version/mod.rs`: `pub mod v15; v16; v17;`, `LATEST_VERSION = PROTOCOL_VERSION_17`.
- `version/protocol_version.rs`: import and register `PLATFORM_V15..V17`,
  `LATEST_PLATFORM_VERSION = &PLATFORM_V17`.
- No `SystemLimits`, no fee schedule, no drive or drive-abci table changes in part 1.

### 4.4 Tests (part 1), all `should_...`, latest generation against `PlatformVersion::latest()`

In `lifecycle/rules/v0/mod.rs` `#[cfg(test)] mod tests` (moved to `v0/tests/` if it outgrows
the file) and `selection/v0/mod.rs`:
- deprecation keeps the version selectable and yields exactly one `Deprecated` warning;
- retire refused on the latest active version; accepted on an older one;
- retire before a promised time rejected with `NoticeNotElapsed` carrying the promise; at the
  promised time and after accepted;
- promise moved later accepted, moved earlier rejected with `NoticeShortened`; the same for the
  upgrade notice; restore keeps the promise;
- activation of a third version leaves the first supported and the second deprecated and clears
  the consumed upgrade notice; `activation_permitted_at` refuses before the notice;
- unsupported version: not selectable by a direct explicit call, no action can bring it back;
- direct explicit selection of a missing version gives `NotFound`; of an unsupported one gives
  `Unsupported`; cross-contract and scheduled explicit selection gives
  `ExplicitSelectionNotAllowed` even for a supported version; latest routing on an empty table
  gives `NoActiveVersion`; deprecated latest is still routed as latest with the warning;
- authority: owner passes under `ContractOwner`, a stranger fails with 40004; a group with
  enough power passes under `Group`; `NoOne` refuses everyone; the contract actor passes only
  with `allow_self_upgrade`;
- no protocol minimum: deprecate then retire in the same block succeeds when no promise exists
  (this is the test that pins Q15's first sentence);
- gate: `PlatformVersion::get(16)` (placeholder, same tables as 14) returns `Err` from both
  dispatchers, `latest()` dispatches; the two dispatchers report `known_versions == [0]` on an
  unknown generation;
- serialization round trips for `ExecutableUpdatePolicy`, `VersionLifecycle`,
  `ExecutableVersionTable` and `LifecycleAction` per the canonical pattern doc (JSON and
  platform value under the conversion features, bincode always), with the `$formatVersion` tag.
- `rs-dpp` test invocation: `cargo test -p dpp smart_contract` (targeted).

### 4.5 Book (part 1)

- `book/src/SUMMARY.md`: add the `# DashVM` section before `# Appendix` (same text and
  position as SDK-01's insertion) with `- [Executable Versions and Promised Notice](dashvm/executable-versions.md)`.
- `book/src/dashvm/executable-versions.md`: the status machine, the five actions, the two
  promise kinds and the cannot-shorten rule, the selection matrix (origin by selection), the
  no-minimum-notice statement, what is deferred (transitions, storage, routing, activation
  wiring), the error table. Status banner as SDK-01's chapter uses.
- `book/src/versioning/platform-version.md`: one paragraph on `contract_versions.smart_contract`
  being `None` before protocol version 17 (only if R06-01's placeholder paragraph is not
  already there after rebase; if it is, append one sentence to it).

## 5. Part 2: method signature descriptor, digest, compatibility report and client surface

Stacked on part 1. PR title:
`feat(dpp): define the method signature descriptor, its digest and the compatibility report`.

### 5.1 `packages/rs-dpp/src/data_contract/smart_contract/method/`

- `mod.rs` + `v0/mod.rs`: `MethodDescriptor { V0 }`, `MethodReceiver`, `MethodParam`,
  `MethodWireType` (variants: `Unit, Bool, Integer(IntegerWidth), F64, String { max_chars: u16 },
  Bytes { max_len: u16 }, Identifier, DocumentId, Option(Box), List { max_len: u32, item: Box },
  Struct(Vec<(String, MethodWireType)>)`; `IntegerWidth::{U8,U16,U32,U64,I8,I16,I32,I64}`; the
  bounds are required here, unlike the SDK-01 declaration form where absence is a diagnostic,
  because the descriptor is the validated output). `MethodSignatureV0` (the projection without
  parameter names) and `signature_digest() -> [u8; 32]` using `hash_single` over the domain tag
  plus `PlatformSerializable::serialize_to_bytes` of the projection.
- `method/validate_structure/mod.rs` (dispatcher on `smart_contract.method_descriptor`) +
  `v0/mod.rs`: name grammar `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` and byte limit (SDK-01's
  provisional grammar, kept identical), parameter count, type nesting depth, struct field count,
  unique parameter names, collection names for receivers under the native document type name
  rule. Returns `SmartContractMethodDescriptorInvalidError { name, reason }` (basic, 10278;
  file under `errors/consensus/basic/data_contract/`, appended to `BasicError`, wasm-dpp arm,
  error-codes row `10200-10278`).
- `method/table.rs`: `MethodTable { V0(MethodTableV0 { methods: Vec<MethodDescriptor> }) }`
  with `try_new(Vec<_>)` sorting by name and rejecting duplicates (`ProtocolError`, it is a
  construction error, not a consensus result; the consensus check for a contract's table lands
  with R08-03), `get(name)`, `names()`, `len()`.

### 5.2 `packages/rs-dpp/src/data_contract/smart_contract/compatibility/`

- `mod.rs` + `v0/mod.rs`: `compatibility_report(from, to) -> CompatibilityReport { V0 }`,
  `MethodChange`, `SignatureDifference::{Receiver, ReadOnly, ParameterCount, ParameterType { position },
  ReturnType}`, `RenamedParameters { name, positions }`, `signature_compatible()`, `Display`.
  The disclaimer constant `SEMANTIC_EQUIVALENCE_DISCLAIMER: &str` is public so the CLI (R13-06)
  and the SDK print the same sentence.

### 5.3 Version tables (part 2)

Amend in place, same unreleased protocol version: `SmartContractVersions` gains
`pub method_descriptor: FeatureVersion` and `pub limits: SmartContractMethodLimits {
max_method_name_bytes: u16, max_params_per_method: u16, max_type_nesting_depth: u8,
max_struct_fields: u16, max_methods_per_contract: u16 }`; `SMART_CONTRACT_VERSIONS_V1` in
`v7.rs` sets `method_descriptor: 0` and the provisional numbers `64, 128, 8, 64, 1024`
(64 from SDK-01's method name bound, 128 and 1024 from the register's per-function parameter
and per-module export caps, 8 and 64 new provisional values). No new table generation, no
`SystemLimits` edit (the numbers are contract-declaration limits read only by the descriptor
validator, so they sit next to its slot as `DashVmLimits` sit next to the preparation slot).

### 5.4 `packages/rs-sdk/src/platform/smart_contract/mod.rs`

Registered in `platform.rs`. Re-exports; `pub trait LogLifecycleWarnings` implemented for
`ResolvedVersion` (`tracing::warn!` with contract id, version, since and promise);
`pub fn describe_compatibility(report: &CompatibilityReport) -> String`; module docs on: the SDK
never chooses an old version for the caller, `VersionSelection::Latest` is the default of every
future direct-call builder, cross-contract and scheduled callers have no selection, a report is
not a semantic guarantee. Book: a short "Executable versions" subsection appended to
`book/src/sdk/put-operations.md` pointing at the DashVM chapters.

### 5.5 Tests (part 2)

- digest golden vector: a fixed descriptor hashes to a pinned hex string (catches encoding
  drift); renaming a parameter keeps the digest; changing a parameter type, the return type,
  the receiver or `read_only` changes it; reordering a `Struct`'s fields changes it (field order
  is wire order);
- report: added, removed, changed (every `SignatureDifference` kind once), renamed, unchanged;
  `signature_compatible()` truth table (empty tables, additions only, one removal, one change);
  `Display` contains the disclaimer sentence verbatim; JSON and bincode round trips for
  `MethodDescriptor`, `MethodTable` and `CompatibilityReport`;
- `validate_structure`: each limit one over its bound, bad name grammar, duplicate parameter
  names, gate `PlatformVersion::get(16)` returns `Err`;
- `MethodTable::try_new` rejects duplicates and sorts;
- rs-sdk: `describe_compatibility` output test and a `tracing` subscriber capture test for the
  warning (or assert on the returned warning list if capture is awkward).
- Invocation: `cargo test -p dpp smart_contract::method`, `cargo test -p dpp smart_contract::compatibility`,
  `cargo test -p dash-sdk smart_contract`.

### 5.6 Book (part 2)

`book/src/dashvm/method-compatibility.md` (added to the DashVM section): descriptor fields,
what the digest covers and excludes, the report and its `Display`, the disclaimer with the
reasoning (a callee may keep a signature and change what it does; bound transfers, validate
returns and postconditions, rely on rollback), the SDK-01 manifest to descriptor mapping table
for the build tool (`Receiver::None -> Free`, `Ref(c) -> Ref { collection }`, `Mut(c) -> Mut`,
`ValueType` variant for variant, `takes_document_id` is derived and not part of the
descriptor), and the note that the numeric method ID is a separate allocation.

## 6. What stays byte-identical

- Every shipped `vN` implementation module in dpp, drive and drive-abci.
- `CONTRACT_VERSIONS_V1..V6` except the one appended `smart_contract: None` line each;
  `PLATFORM_V1..V14` untouched (the new field lives inside `DPPContractVersions`, which those
  files reference by constant name).
- Mock version tables (`mocks/v2_test.rs`, `v3_test.rs`) reference `CONTRACT_VERSIONS_V1` and
  need no edit.
- `StateError` and `BasicError` existing variants and codes; `wasm-dpp2` (code based).
- No state transition, Drive path, proof, fee, `SystemLimits` or ABCI code changes.
- The 5.0 placeholder `v15.rs`/`v16.rs` are the sibling bytes.

## 7. Versioning consequences (summary)

| Surface | Part | Change |
| --- | --- | --- |
| `DPPContractVersions` | 1 | new `smart_contract: Option<SmartContractVersions>`, `None` on V1..V6 |
| `CONTRACT_VERSIONS_V7`, `SMART_CONTRACT_VERSIONS_V1` | 1 (amended in 2) | new, selected by `PLATFORM_V17` only |
| `PLATFORM_V15..V17`, `LATEST_VERSION` | 1 | scaffolding shared with every open 5.0 sibling |
| `StateError` 40010..40015 | 1 | six appended variants, wasm-dpp arms, book row |
| `BasicError` 10278 | 2 | one appended variant, wasm-dpp arm, book row (10277 left to the contested-index PR) |
| New dpp versioned methods | 1 and 2 | `check_lifecycle_action`, `apply_lifecycle_action`, `resolve_executable_version`, `MethodDescriptor::validate_structure`, all generation 0 |
| Proto, DAPI, Drive, ABCI, fees, SystemLimits | none | untouched |
| rs-sdk | 2 | new `platform::smart_contract` module, additive |

## 8. Provisional values and interpretations (go in both PR bodies)

1. Protocol numbers 15, 16, 17 are the register's provisional allocation; the tables move if
   the register changes.
2. Retirement is terminal: `Unsupported` cannot be restored. Policy says once unsupported a
   version cannot be selected and its code remains; it does not say whether re-support is
   allowed. Terminal is the conservative reading (no resurrection surprises); reversing it
   later is additive (a new action) and needs no new generation of anything shipped.
3. The latest active version cannot be retired (only deprecated). Policy gives freeze and wipe
   for stopping a contract; leaving latest routing with no target through a lifecycle action
   would be a third way and is not chosen.
4. A promise has no upper bound. A version promised until the far future is un-retirable; that
   is the contract's binding announcement.
5. Retirement takes effect in the block that applies it and is refused before the promised time;
   no scheduled future retirement is modelled (the activation boundary owner, R08-14, can add
   one later without changing these rules).
6. The upgrade notice covers the next activation only and is consumed by it; a contract that
   wants a standing notice announces it again after each activation.
7. Deprecate on an already deprecated version is accepted (keeps the original `since`), so a
   promise can be attached after the fact; restore withdraws the warning and never the promise.
8. Parameter names are excluded from the signature digest and reported as renames; every other
   descriptor field is covered. Field order of a `Struct` type is wire order.
9. Method descriptor limits `64 / 128 / 8 / 64 / 1024` and the method name grammar are
   provisional under register entries A07 and A24, aligned with SDK-01 and the DashVM limit
   table on the R08-01 branch.
10. Authority failures reuse the existing "action not allowed on data contract" error rather
    than a new code; the action name distinguishes the five actions.
11. `ExplicitSelectionNotAllowed` is not a consensus error: no transition can carry a
    cross-contract or scheduled pin; it is a host-side rejection mapped by the error taxonomy
    task.
12. The compatibility report is versioned by struct generation only, with no protocol table
    slot, because no consensus rule consumes it.

## 9. Hand-offs recorded for other tasks (sent as `dashvm note` when the part 1 PR opens, so the notes name types that exist; repeated in the PR body)

- R08-03: embed `ExecutableUpdatePolicy`, `MethodTable` and `ExecutableVersionTable` (or its
  stored projection) into the smart contract declaration and storage; validate a contract's
  `MethodTable` through `MethodDescriptor::validate_structure` and the table's duplicate rule.
- R11-14: the five `LifecycleAction`s are the semantic content of the lifecycle transition(s);
  state validation calls `check_lifecycle_action`, execution calls `apply_lifecycle_action`;
  the direct call transition carries `VersionSelection` and its state validation calls
  `resolve_executable_version` with `CallOrigin::Direct`.
- R10-11 / CALLS: cross-contract and scheduled routing call `resolve_executable_version` with
  `CallOrigin::CrossContract` / `Scheduled` and `VersionSelection::Latest`.
- R08-14: the activation boundary calls `activation_permitted_at` before `activate`.
- R12-07: map `VersionResolutionError::ExplicitSelectionNotAllowed` into the guest error
  taxonomy (`InactiveVersion` family).
- R13-06 / SDK-04: `dash-contract-build` maps the SDK-01 `CanonicalManifest` method table onto
  `MethodTable` (mapping table in the part 2 book chapter) and prints
  `compatibility_report` between the previous and the new build; clients use
  `LogLifecycleWarnings`.
- R08-04: the numeric method ID is separate from `signature_digest`; both are carried by the
  manifest.

## 10. Local gate (per part)

```bash
cargo fmt --all
cargo clippy -p dpp --all-features --all-targets -- -D warnings > /tmp/fix11-clippy-dpp.txt; echo $?
cargo clippy -p platform-version --all-features --all-targets -- -D warnings > /tmp/fix11-clippy-pv.txt; echo $?
cargo clippy -p dash-sdk --all-features --all-targets -- -D warnings > /tmp/fix11-clippy-sdk.txt; echo $?   # part 2
cargo check --workspace --all-targets > /tmp/fix11-check.txt 2>&1; echo $?     # field added to DPPContractVersions
cargo test -p dpp smart_contract > /tmp/fix11-test-dpp.txt 2>&1; echo $?
cargo test -p platform-version > /tmp/fix11-test-pv.txt 2>&1; echo $?
cargo test -p dash-sdk smart_contract > /tmp/fix11-test-sdk.txt 2>&1; echo $?   # part 2
cargo check -p wasm-dpp --target wasm32-unknown-unknown > /tmp/fix11-check-wasm-dpp.txt 2>&1; echo $?
```

Use a private `CARGO_TARGET_DIR` if the shared one shows stale platform-version symbols (see
the fingerprint collision memory). The `wasm32` check of `wasm-dpp` needs the homebrew clang
environment from the memory pack if secp256k1-sys is rebuilt.

## 11. Risks and checks

- Raising `LATEST_VERSION` to 17 with placeholder tables: every open sibling did it and passed
  the Rust workspace tests; fee pins moved only with R04-01's root tree change, which this task
  does not touch. If a test pins latest as 14 it shows up in `cargo check/test` locally.
- Forward-merge conflicts on `v17.rs`, `version/mod.rs`, `protocol_version.rs`, `codes.rs`,
  `state_error.rs`, `wasm-dpp consensus_error.rs`, `SUMMARY.md`, `error-codes.md` with the
  siblings: all are append or one-line struct-update conflicts; resolve by keeping both sides.
- `10277` is claimed by an unmerged PR; taking `10278` leaves a hole if that PR never lands.
  Acceptable and stated in the part 2 body.
- The SDK-01 method vocabulary may change before it merges forward; the part 2 chapter carries
  the mapping so the build-tool adapter is a documented one-file change.
- `ExplicitSelectionNotAllowed` has no consensus code by design; a reviewer may ask for one.
  The answer is in section 8 item 11.

## 12. Estimated diff

Part 1 about 2,000 lines (models and rules 750, six errors 360, tables and placeholders 220,
wasm-dpp 30, tests 450, book 200). Part 2 about 1,400 lines (descriptor and digest 350,
report 300, error and tables 80, rs-sdk 150, tests 350, book 170). Total about 3,400 lines,
almost all additions.
