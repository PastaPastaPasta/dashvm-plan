# FIX-06 plan: enforce code-specific admission limits before full decoding

Working artifact. Never staged, never committed. Delete when the task ships.

Planned 2026-09-17 on `v5.0-dev` (tip `5f1e0ccdce`, `LATEST_VERSION = 14`). Base stays
`v5.0-dev`: the contract-code envelope generation and its tables exist only on the 5.0 protocol
version. Tier stays `xhigh`: the work sits on the decode path every block and every CheckTx runs,
and it adds a consensus rejection rule.

**Status: blocked on R06-05.** This task is a refinement of R06-05 ("extend contract
create/update transitions for large canonical code"). R06-05 is two parts: part 1 (PR #4717,
open, reviewer consensus reached, thepastaclaw re-review pending on head `d6109d2d6b`) lands the
family caps, the wire-prefix family peek and the bounded decode generation; part 2 (not started)
lands the V1 contract transitions with the code bundle. FIX-06's deliverable is a bounded parser of
that envelope, so it has no wire layout to parse until part 2 exists, and the runner cannot stack
a task on a multi-part prerequisite. Everything below is planned against R06-05's plan
(`/Users/dashvm/work/wt/R06-05/PLAN.md`, sections 3 D5 to D9 and 4 part 2) and the part 1 branch
(`origin/dashvm/r06-05`); section 11 lists what the replan must verify once R06-05 has merged.

## 1. Acceptance, restated

The issue asks for four things (FIX-06 acceptance, Q39, Q40, and section 6 of the findings
resolutions, "larger code transitions without larger ordinary transitions"):

1. **A bounded canonical envelope parser.** Given the raw bytes of a contract create or update
   transition in the contract-code capable generation, obtain the version and type, then bound
   every length the code bundle declares (module count, each name, each module's code, the bundle
   total) against the protocol tables and against the bytes actually present, before any
   allocation proportional to a declared length and before the contract schema is decoded.
   Malformed input (a length claim beyond the input, an unknown variant, a non-minimal length
   encoding, a name that is not valid) is rejected at the same point.
2. **Substantial family-specific size limits, ordinary limits kept.** The contract-code family
   keeps the provisional 32 MiB cap R06-05 introduced; every other family keeps 20 KiB; and the
   part of a code envelope that is not code (the contract declarations, nonces, key id, signature)
   is bounded by the ordinary cap, so the larger envelope buys code, not a larger native contract.
3. **Coherent admission on every ingress path.** One dpp function is the admission rule, and DAPI
   (before Tenderdash), CheckTx and RecheckTx (mempool), the block decoder (proposal and
   validation, replay), `getProofs` and the Rust and JavaScript client builders all call it, so a
   client sees the same rejection whether DAPI, the mempool or a block refused the bytes.
4. **Q40.** Every number is a provisional table value with the register row it comes from, named
   provisional in a code comment and in the PR body; no wire, storage or ABI identifier is invented
   (the task allocates one consensus error code from the real registry and one `SystemLimits`
   field, and no proto message).

Explicitly not here: the WASM admission of the module bytes themselves (feature allowlist,
structural caps, instrumentation) is `rs-dashvm-validation`'s `admission` module (R08-01, PR
#4712); the bundle's hash binding and fees are R06-05 part 2; permanent storage is R06-04;
manifests and bindings are R08-03 (which extends the walker of D3 when the bundle grows); the
readiness transport is FIX-09. The module catalog lists `admission/envelope.rs` under VALIDATE;
that file is the WASM-level admission entry. The state-transition envelope is a protocol wire shape
with consensus errors, so its parser lives in `rs-dpp` (conventions: "a protocol type, its wire
shape, or a pure-data invariant" goes in dpp; `dashvm-validation` depends on `platform-version`
only and dpp does not depend on it).

## 2. Tree inspection and drift

Observed on `5f1e0ccdce` plus the open sibling branches. The issue cites no line numbers for
FIX-06; the findings resolutions cite `decode_raw_state_transitions/v0/mod.rs#L53` on the same
commit, which is still the size gate (line 55 today).

| Item | Observed |
| --- | --- |
| `packages/rs-dpp/src/state_transition/mod.rs:460-461` | `#[platform_serialize(unversioned)]` then `#[platform_serialize(limit = 100000)]`. The derive (`rs-platform-serialization-derive/src/lib.rs:121-124` and `:258-261`) takes `.find(..)` on the attribute list, so only the first attribute is parsed and the limit is never applied: `deserialize_from_bytes` is generated with `with_no_limit()`. Same on the `v4.1.1` tag. R06-05 recorded this as a finding for FIX-06. |
| Probe (this lane, removed) | `StateTransition::deserialize_from_bytes` on a 50-byte crafted `IdentityCreditWithdrawal` whose `output_script` claims 2^62 bytes aborts the process (`memory allocation of 4611686018427387904 bytes failed`); a claim of `u64::MAX` panics with `capacity overflow`. bincode 2.0.1's `Vec<u8>` decode runs `vec![0u8; len]` before reading (`features/impl_alloc.rs:266-270`); the existing test `deserialize_crafted_huge_vec_length_does_not_oom` passes only because an 8 GB zeroed allocation succeeds lazily on this machine. Reachable from DAPI broadcast (pre-filter is size-only), Tenderdash CheckTx and the block decoder on `v5.0-dev` and on `v4.1.1`. |
| `v4.2-dev` commit `2c0b81116a` (PR #4625, owner, 2026-09-14, `fix(platform)!`) | Moves the workspace to `grovedb-bincode 2.1.0` and splits `PlatformDeserializable` into `PlatformDeserializableTrusted` and `PlatformDeserializableUntrusted`; every remote decode (`decode_raw_state_transitions`, CheckTx, `getProofs`, DAPI error mapping, wasm factories) calls `deserialize_from_bytes_untrusted`, whose byte-vector decode "first verifies the available payload" before allocating. On `v4.2-dev` and `v4.3-dev`, **not on `v5.0-dev`** (117 commits behind `v4.2-dev`). This is the generic fix for the row above; FIX-06 must not duplicate it and must not depend on when it is forward-merged (D6). |
| `origin/dashvm/r06-05` (part 1) | `dpp/state_transition/envelope_kind.rs`: `peek_envelope_kind` (outer index 0 or 1, inner index 1), `family_max_size`, `family_decode_budget`, `deserialize_from_bytes_with_budget` (bincode `with_limit::<67_108_864>` for the code family, shipped decode for the rest), `deserialize_from_bytes_in_version_bounded`. `SystemLimits` gains `max_contract_code_state_transition_size` (32 MiB), `max_contract_code_state_transition_decode_budget` (64 MiB), `max_contract_code_bundle_bytes` (16 MiB), `max_contract_code_modules_per_bundle` (16), `None` on V1 to V4 and the mocks, set on `SYSTEM_LIMITS_V5` with a const consistency assertion. `decode_raw_state_transitions/v1` (selected by `DRIVE_ABCI_METHOD_VERSIONS_V11`, `PLATFORM_V17` only) compares the raw length with the family cap and decodes through the bounded entry; `query/proofs/v1` likewise. `rs-dapi` pre-filter applies the family cap from `PlatformVersion::latest()`; a per-method body limit gives `broadcastStateTransition` 34 MiB and every other Platform method 128 KiB. `StateTransitionFamilyMaxSizeExceededError` is code 10604. |
| R06-05 plan, part 2 (D8, D9) | `DataContractCreateTransitionV1` and `DataContractUpdateTransitionV1` carry `code_bundle: Option<CodeBundleSubmission>`; `CodeBundleSubmission::V0(CodeBundleSubmissionV0 { modules: Vec<CodeModuleSubmission> })`, `CodeModuleSubmission::V0(CodeModuleSubmissionV0 { name: String, canonical_hash: [u8; 32], code: Vec<u8> })`. Bounds: at most 16 modules, names 1 to 64 bytes of lower-case ASCII alphanumerics and underscore, unique and strictly ascending, non-empty code, sum of code at most the bundle bytes; validated at basic structure (create v3, update v2) **after** the envelope is decoded into owned vectors. Six data-contract errors 10277 to 10282. The field order inside the V1 structs is not fixed by the plan ("the existing fields plus an optional bounded code bundle"). |
| bincode 2.0.1 wire facts | Enum variant index: `u32` varint. `Option`: one tag byte, 0 or 1 (`de/mod.rs:312-326`). `Vec` and `String` length: `u64` varint. `[u8; 32]`: 32 raw bytes. Varint: single byte for 0 to 250, marker 251 plus `u16`, 252 plus `u32`, 253 plus `u64`; the decoder accepts non-minimal forms (`varint/decode_unsigned.rs:226-257`), the encoder always emits the minimal one. `<&[u8]>::borrow_decode` claims and takes a slice without copying (`de/impls.rs:455-463`). |
| `rs-drive-abci` ingress | `check_tx/v0/mod.rs:121` decodes through `decode_raw_state_transitions`; `InvalidEncoding` becomes an unpaid rejection with the consensus code, `FailedToDecode` an `Err` (node fault). `process_raw_state_transitions/v0` files `InvalidEncoding` as `UnpaidConsensusError`; `prepare_proposal` removes those, `process_proposal` rejects a block carrying one. `query/proofs/v0` decodes with the shipped entry; part 1's `v1` applies the family cap. `server.rs` (part 1) caps the CheckTx and DriveInternal gRPC services at 34 MiB. |
| `rs-dapi` ingress | `broadcast_state_transition.rs:210` `validate_state_transition_bytes` (size only, `InvalidArgument`), then Tenderdash `broadcast_tx_sync`; duplicates go through `check_tx`. `error_mapping.rs`: `TenderdashStatus { code, message, consensus_error }` becomes a gRPC status with `dash-serialized-consensus-error-bin` metadata, which `rs-sdk` (`error.rs:163-198`) and wasm parse into a typed consensus error. `wait_for_state_transition_result.rs:260` re-sends the bytes to Drive `getProofs`. The gateway rate limiter is per remote address, not per method. |
| Clients | `rs-sdk/platform/transition/broadcast_request.rs:70` serialises with `serialize_to_bytes` and no size check; `broadcast.rs:123` and `:382` build the request; `Sdk::version()` (`sdk.rs:620`) returns the network's protocol version. `wasm-dpp2/state_transitions/base/state_transition.rs:241-263` `fromBytes`, `fromHex`, `fromBase64` decode with `deserialize_from_bytes`; part 2 routes them through the bounded entry with `PlatformVersion::latest()`. `rs-platform-wallet` broadcasts through `rs-sdk`. |
| `rs-drive/src/verify/bounded_decode.rs` | Precedent for "check the declared length, then decode under a budget": a proof's contract is capped at `contract_versions.max_serialized_size` (65,000) before decoding under 16 MiB. |
| Consensus error registry | `codes.rs`: state transition band 10600 to 10699; 10604 taken by part 1; part 2 uses the data contract band (10277 to 10282). Next free state transition code: 10605 (verify at implementation). |
| Runner | `stackable_prereq` refuses to stack on a prerequisite with `parts`; R06-05 has two. The `blocked_on` result appends R06-05 to `depends_on` and replans when it is done. |

## 3. Decisions

- **D1. One rule, one function: `StateTransition::admit_serialized`.** New in
  `packages/rs-dpp/src/state_transition/admission.rs`:
  `pub fn admit_serialized(bytes: &[u8], platform_version: &PlatformVersion) -> Result<StateTransitionAdmission, ConsensusError>`.
  It peeks the kind (R06-05's `peek_envelope_kind`), compares the raw length with
  `family_max_size` (returning the existing `StateTransitionMaxSizeExceededError` or
  `StateTransitionFamilyMaxSizeExceededError`), and for `ContractCodeCapable` runs the bounded walk
  of D3. `StateTransitionAdmission { kind, max_size, contract_code: Option<ContractCodeEnvelopeSummary> }`.
  A rejection is a `ConsensusError` (always a `BasicError`), never a `ProtocolError`: two nodes
  must agree on it, and every caller classifies it as an unpaid rejection. It allocates nothing
  proportional to the input.
- **D2. The callers, and nothing else, decide admission.** `decode_raw_state_transitions` v1
  replaces its inline cap comparison with `admit_serialized` and files `Err` as `InvalidEncoding`
  (unpaid) exactly like the cap today; CheckTx and RecheckTx go through it; `query/proofs` v1
  likewise; `deserialize_from_bytes_in_version_bounded` calls it first, so the wasm factories and
  any future caller of the bounded entry are covered without a second call site; rs-dapi's
  pre-filter calls it with `PlatformVersion::latest()` (a static upper bound, as today: caps only
  grow with the version, Drive enforces the active one); the rs-sdk broadcast path calls it with
  `sdk.version()` after serialising, before the network round trip. No check is duplicated in
  wasm, the FFI crates or the mobile SDKs (they marshal to these entry points).
- **D3. The bundle skeleton is walked from the prefix with borrowed reads; the rest of the
  envelope is bounded by its byte length, not decoded.** The walker reads: outer variant index
  (u32 varint, 0 or 1), inner variant index (1), then the `Option<CodeBundleSubmission>` tag. Tag
  0: no bundle. Tag 1: bundle variant index (0), module count (u64 varint, at most
  `max_contract_code_modules_per_bundle`), then per module: variant index (0), name length (u64
  varint, 1 to `MODULE_NAME_MAX_BYTES` = 64) and name bytes (present in the input, valid per the
  single module-name predicate of `code_bundle/v0`, strictly greater than the previous name),
  32 hash bytes (present), code length (u64 varint, at least 1, running total at most
  `max_contract_code_bundle_bytes`, and at most the bytes remaining in the input) and the code
  bytes skipped. Every length is checked against `remaining()` before the cursor moves, so a claim
  beyond the input is rejected before anything is materialised. The bytes after the bundle
  (`bytes.len() - cursor`) are the native section: they must be at most
  `max_contract_code_state_transition_native_bytes` (D4). The walker returns
  `ContractCodeEnvelopeSummary { family, module_count, bundle_bytes, native_bytes }`. This
  requires `code_bundle` to be the **first field** of both V1 structs (see D8 and the note sent to
  R06-05): with the bundle first, the native contract never has to be walked, and the walker's
  shape stays a dozen lines that R08-03 extends when the manifest joins the bundle.
- **D4. The native section of a code envelope keeps the ordinary limit.** New
  `SystemLimits.max_contract_code_state_transition_native_bytes: Option<u64>`: `None` on
  `SYSTEM_LIMITS_V1` to `V4` and the mock tables; `Some(20_480)` on `SYSTEM_LIMITS_V5` (amended in
  place, one unreleased table generation), provisional, equal to `max_state_transition_size`, read
  as the register's "keep other transition-family limits" and the findings resolutions' "preserve
  existing ordinary limits unless separately changed". A separate field rather than a reuse of
  `max_state_transition_size`, because the owner may later want larger declarations without a
  larger ordinary transition, and because the doc comment on the field is where the relation is
  explained. The const assertion on `SYSTEM_LIMITS_V5` gains: native cap at most the family cap,
  and native cap plus bundle bytes plus framing at most the family cap. The `PlatformVersion`
  tests loop `PLATFORM_VERSIONS` for the field being absent below 17 and present from 17 (the
  decoder's behaviour depends on it; the trivial slot-value tests the conventions forbid are not
  written).
- **D5. Errors.** Over-limit bundle bounds map to the part 2 errors for the same rule, so a
  client sees one code whether the wire walk or the decoded-form check found it:
  `TooManyCodeModulesError` (count), `CodeModuleNameError` (length, grammar, order),
  `EmptyCodeModuleError`, `CodeBundleTooLargeError` (total). A malformed skeleton (a length claim
  beyond the input, a tag or variant index outside its range, a non-minimal varint, invalid UTF-8
  in a name, input ending inside the skeleton) is `SerializedObjectParsingError` (10002) with a
  message naming the position and the rule, as decode failures are today. The native section over
  its cap is a new `StateTransitionNativeSectionMaxSizeExceededError { family, actual_size_bytes, max_size_bytes }`,
  next free code in the state transition band (10605, verified at implementation), appended to
  `BasicError` with the standard derive stack and a `wasm-dpp` mapping arm. The over-cap total
  keeps 10604 (part 1). The `CodeBundleNotSupportedError` rule (bundle present while the table has
  no `contract_code_bundle` slot) stays in basic structure: it reads a feature slot, not a byte
  bound, and a walker that rejected it would make the pre-activation rejection depend on decode
  order for no gain.
- **D6. Independent of the untrusted-decoder forward merge, and safe on both sides of it.** The
  walker guarantees every module length is backed by input before the decoder allocates it, so the
  code family is safe under bincode 2.0.1's `vec![0u8; len]` today and unchanged under
  `grovedb-bincode 2.1.0`'s untrusted decode after `v4.2-dev` is merged forward. The ordinary
  families' exposure (section 2, probe row) is fixed by that forward merge, not by this task; the
  plan and the PR body say so, and this task adds no second mechanism for them. When the forward
  merge lands first, R06-05's `deserialize_from_bytes_with_budget` and the bounded entry are
  renamed to the untrusted forms by R06-05's rebase; FIX-06 follows at its own rebase and the
  walker is untouched by it.
- **D7. Canonical means minimal.** The walker requires the minimal bincode varint form for every
  length and variant index it reads (bincode's encoder never emits another form, pinned by a test
  over real envelopes). This is the one place the protocol says "canonical" about the envelope
  (DVM-01: "noncanonical ordering or integer overflow cannot acquire alternate valid
  interpretations"); it is stricter than the decoder, which accepts non-minimal forms, and the
  strictness is only ever on the walker's side, so anything the walker admits the decoder decodes
  to the same lengths. Provisional interpretation, recorded in the PR body.
- **D8. The walker and the decoded-form validation are one rule with two readers.** Part 2's
  `CodeBundleSubmissionV0::validate_structure` (pure-data tier, for constructed objects and the
  basic-structure generations) and the walker (for bytes) must accept exactly the same bundles.
  The module-name predicate is one public function in `code_bundle/v0`, and the numeric bounds are
  the same table fields. A seeded property test serialises generated bundles (valid and each
  one-over case) and asserts `admit_serialized(serialize(t)).is_ok() == validate_structure(t).is_valid()`
  for every case, the same alignment discipline PR #4115 used for the value depth limit. The
  basic-structure checks stay (they are reachable for in-process objects and are the paid path's
  defence in depth); the walker is what makes them unreachable for wire input.
- **D9. Generations are amended in place, not added.** `decode_raw_state_transitions/v1`,
  `query/proofs/v1` and `SYSTEM_LIMITS_V5` are selected by protocol version 17 only, which no
  network runs, so the conventions' rule for an unreleased generation applies: change them in
  place. `v0` of both stays byte-identical; the part 1 tests that pin `v0` at 16 stay. No new
  `DRIVE_ABCI_METHOD_VERSIONS_*` or `DRIVE_ABCI_QUERY_VERSIONS_*` generation.
- **D10. DAPI reports an admission rejection exactly as a CheckTx rejection.** The pre-filter
  returns `DapiError::TenderdashClientError(TenderdashStatus::from_consensus_error(&error, PlatformVersion::latest()))`
  (new constructor: code from `ErrorWithCode`, message from `Display`, `consensus_error` from
  `serialize_to_bytes_with_platform_version`), so the gRPC status carries the code and the
  `dash-serialized-consensus-error-bin` metadata the SDK already parses into a typed
  `StateTransitionBroadcastError`. The ordinary over-cap rejection changes shape too (from
  `InvalidArgument` text to the 10602 status): one shape for every admission rejection, recorded
  in the PR body as a client-visible change. The empty-bytes case keeps `InvalidArgument`. No new
  rate limit: the walk is linear in the input and allocation-free, cheaper than the base64 encode
  that follows it, and the gateway limiter already bounds requests per address (findings
  resolutions section 6 asks for rate limits on repeated failed submissions; that is R09-09 and
  operator configuration, noted in the PR body).
- **D11. No proto change.** WIRE scope is met by admitting on the existing
  `broadcastStateTransition` and `getProofs` messages; no upload or chunk message is added (Q39).
  Tenderdash and dashmate sizes are part 1's and are not touched.

## 4. Approach by crate and file

`packages/rs-dpp`
- `src/state_transition/admission.rs` (new): `StateTransitionAdmission`,
  `ContractCodeEnvelopeSummary`, `StateTransition::admit_serialized`, the private
  `ContractCodeEnvelopeWalker` (cursor over `&[u8]`; `read_varint_u64_minimal`,
  `read_varint_u32_minimal`, `read_option_tag`, `take(n)`, `remaining()`), the
  `MODULE_NAME_MAX_BYTES` constant if part 2 did not already place it in `code_bundle/v0` (then
  it is imported from there). Doc comment states the wire skeleton byte by byte and why the bundle
  is walked and the native section only measured.
- `src/state_transition/envelope_kind.rs` (part 1): `deserialize_from_bytes_in_version_bounded`
  calls `admit_serialized` before decoding and maps its error to
  `ProtocolError::ConsensusError` (the existing not-active mapping already uses that variant, and
  the v1 decoder already files it as `InvalidEncoding`).
- `src/state_transition/mod.rs`: `pub mod admission;`.
- `src/state_transition/state_transitions/contract/code_bundle/v0/mod.rs` (part 2): expose the
  module-name predicate as one `pub fn` if part 2 kept it private; no rule change.
- `src/errors/consensus/basic/state_transition/state_transition_native_section_max_size_exceeded_error.rs`
  (new), `basic_error.rs` variant appended, `codes.rs` 10605.
- `src/state_transition/serialization.rs`: the existing crafted-length tests gain a sibling that
  goes through `admit_serialized` for a code envelope claiming 2^62 module bytes and asserts a
  parsing error without allocation (the ordinary-family sibling is deliberately not written here;
  see D6).

`packages/rs-platform-version`
- `src/version/system_limits/mod.rs`: `max_contract_code_state_transition_native_bytes: Option<u64>`
  with a doc comment naming the method (`admit_serialized`, read by `decode_raw_state_transitions`
  v1) and the register row; `v1.rs` to `v4.rs` and `mocks/{v2_test,v3_test}.rs`: `None`; `v5.rs`:
  `Some(20_480)` with the provisional comment and the extended const assertion. The
  `PLATFORM_VERSIONS` loop test for absent-below-17, present-from-17.

`packages/rs-drive-abci`
- `src/execution/platform_events/state_transition_processing/decode_raw_state_transitions/v1/mod.rs`:
  the cap block becomes `match StateTransition::admit_serialized(raw, platform_version)`; `Err`
  is `InvalidEncoding` with `elapsed_time: Duration::default()` as today; on `Ok` the bounded decode
  runs. Tests: section 7.
- `src/query/proofs/v1/mod.rs`: same replacement; `Err` becomes
  `QueryValidationResult::new_with_error(QueryError::Protocol(ProtocolError::ConsensusError(..)))`
  as the current cap rejection does (verify the exact variant part 1 used).
- `src/execution/check_tx/v0/mod.rs` tests only: a malformed code envelope through
  `platform.check_tx` is rejected with the consensus code and never reaches the fee estimate.

`packages/rs-dapi`
- `src/services/platform_service/error_mapping.rs`: `TenderdashStatus::from_consensus_error`.
- `src/services/platform_service/broadcast_state_transition.rs`: `validate_state_transition_bytes`
  keeps the empty check, then `StateTransition::admit_serialized(tx, PlatformVersion::latest())`
  mapped per D10. Tests updated and extended (section 7). Verify there is no second broadcast
  ingress (the JSON-RPC surface serves Core methods; grep `broadcast_state_transition` outside the
  platform service).

`packages/rs-sdk`
- `src/platform/transition/broadcast.rs`: in both places the request is built (`:123`, `:382`),
  `StateTransition::admit_serialized(&request.state_transition, sdk.version())` mapped to
  `Error::Protocol(ProtocolError::ConsensusError(..))` before the request is sent. Offline test
  with the mock SDK.

`packages/wasm-dpp2`
- Nothing beyond the arm `wasm-dpp` needs for the new error (`wasm-dpp/src/errors/consensus/consensus_error.rs`;
  `wasm-dpp2/src/consensus_error.rs` only if it branches on codes). The factories are covered
  through the bounded entry (D2).

`book`
- `src/state-transitions/lifecycle.md`, section "Size caps and decode budgets per family" (part
  1): the admission walk, the native-section cap and the ordering of the checks;
  `src/error-handling/error-codes.md`: 10605.

## 5. Versioning consequences and what stays byte-identical

- New `SystemLimits` field, backfilled `None`, set on `SYSTEM_LIMITS_V5` (amended in place).
- New consensus error 10605 appended to `BasicError`; `wasm-dpp` arm.
- No new method generation: `decode_raw_state_transitions` v1, `proofs_query` v1 amended in
  place (unreleased). No table constant added.
- No fee schedule change, no proto change, no storage change, no `DecodeUntrusted` change.
- Byte-identical: `decode_raw_state_transitions/v0`, `query/proofs/v0`, `SYSTEM_LIMITS_V1` to
  `V4` apart from the `None` backfill line, every shipped `PLATFORM_V*`,
  `StateTransition::deserialize_from_bytes` and `deserialize_from_bytes_in_version`, every basic
  structure generation below the part 2 ones, the DAPI body limit layer, the Tenderdash and
  dashmate configuration.
- Consensus impact: at protocol version 17 a contract-code envelope whose bundle skeleton
  violates a bound, is malformed, or whose native section exceeds 20 KiB is an unpaid rejection in
  CheckTx and in the block decoder. Part 2 already rejects the same bundles at basic structure
  (unpaid, same codes) after decoding them; what changes is where and at what cost, plus the new
  native-section rule and the minimal-varint rule. `feat(platform)!` for the PR title, since the
  rejection set at 17 changes.

## 6. Dependencies

- **Blocked on R06-05** (both parts). Evidence: the walker parses `DataContractCreateTransitionV1`,
  `DataContractUpdateTransitionV1`, `CodeBundleSubmission` and `CodeModuleSubmission`, none of
  which exist on `v5.0-dev`; the errors it reuses (10277 to 10282) and the tables it reads
  (`max_contract_code_*`) are part 1 and part 2; `decode_raw_state_transitions/v1` and
  `query/proofs/v1` it amends are part 1. Stacking is not available for a multi-part prerequisite.
- Not blocked on R08-01 (`dashvm-validation`): the envelope bounds are `SystemLimits` fields, and
  the per-module bound is implied by the bundle total (16 MiB), which equals R08-01's provisional
  `max_canonical_module_bytes`; the WASM-level admission stays in that crate.
- Not blocked on the `v4.2-dev` forward merge (D6), but the PR body names it as the fix for the
  ordinary families' exposure.
- Coordination sent to R06-05 as a task note (2026-09-17): put `code_bundle` first in both V1
  structs; expose the module-name predicate; FIX-06 amends decode v1 and proofs v1 in place and
  adds the alignment test. If part 2 lands with the bundle elsewhere, FIX-06 moves it to the front
  in the same protocol version (unreleased wire generation; the pinning test over real serialized
  envelopes and the `$formatVersion` serde tests are updated), and says so in the PR body.

## 7. Tests

`rs-dpp` `admission` (all names start with `should_`):
- accepts a real signed V1 create and update envelope with no bundle, with one module, with 16
  modules, with a bundle at exactly `max_contract_code_bundle_bytes`, and with a native section
  at exactly the native cap; the summary reports the counts and byte totals the builder used.
- rejects, with the expected code, one over each bound: 17 modules, a 65-byte name, an empty
  name, a name with an upper-case or non-ASCII byte, two equal names, names out of order, an empty
  module, a bundle one byte over the total, a native section one byte over the cap, a total one
  byte over the family cap (10604 from the size stage, before the walk).
- rejects before allocation: a 60-byte envelope whose first module claims 2^62 bytes, one whose
  module count claims 2^40, one whose name length claims 2^20 (parsing error each time; the test
  runs in the ordinary test process, so an allocation attempt would abort it).
- rejects a non-minimal varint for each of: outer index, inner index, module count, name length,
  code length; accepts the same envelope re-encoded minimally (D7).
- rejects an option tag of 2, a bundle variant index of 1, a module variant index of 1 (parsing
  error naming the position).
- every proper prefix of a real 3-module envelope is rejected without panic (loop over
  truncation points).
- V0 contract transitions and every other family: `Ordinary`, no walk, ordinary cap (loop over the
  serialized fixtures part 1 already has).
- alignment property (D8): 200 seeded bundles across the valid and one-over cases, walker verdict
  equals `validate_structure` verdict.
- `deserialize_from_bytes_in_version_bounded` on a rejected envelope returns
  `ProtocolError::ConsensusError` carrying the same error the walker produced.

`rs-platform-version`: the field is `None` for every registered version below 17 and `Some` from
17 (loop over `PLATFORM_VERSIONS`); the const assertion compiles.

`rs-drive-abci`:
- `decode_raw_state_transitions/v1`: a malformed and an over-bound envelope are `InvalidEncoding`
  with the expected codes; a maximal valid envelope reaches decode (decodes when unsigned, or
  fails later than admission); the existing at-the-cap garbage test's expectation becomes "parsing
  error from admission" (same classification); dispatcher test runs the same inputs through v0 at
  16 (ordinary cap only, no walk) and v1 at latest.
- `process_raw_state_transitions`: one rejected envelope is `UnpaidConsensusError` with the code.
- `check_tx`: the 2^62 claim envelope and a 17-module envelope are rejected with their codes; the
  process survives.
- `query/proofs/v1`: an over-bound envelope is a query error with the code.

`rs-dapi`: pre-filter returns the consensus status (code and metadata) for a malformed bundle, a
17-module bundle, an over-native-cap envelope and an over-cap ordinary transition; a valid code
envelope at the family cap passes the pre-filter; the empty case keeps `InvalidArgument`; the
gRPC status carries `dash-serialized-consensus-error-bin` that decodes to the same error.

`rs-sdk` (offline, mock SDK): broadcasting a transition with an over-bound bundle fails with
`Error::Protocol(ConsensusError)` and no request is recorded.

## 8. Provisional values and interpretations (PR body)

- `max_contract_code_state_transition_native_bytes = 20_480` at protocol version 17: register
  "keep other transition-family limits"; measured with the rest of the caps before activation.
- Module name bound 64 bytes and grammar: R06-05 part 2's D8 (the register gives none).
- Minimal varint requirement in the bundle skeleton (D7).
- The native section is measured, not walked: a code envelope's contract declarations are bounded
  by size only, exactly as an ordinary contract is today.
- DAPI reports every admission rejection as the CheckTx status shape, including the ordinary
  over-cap case (client-visible change).
- The ordinary families' unbounded decode is fixed by forward-merging `v4.2-dev` (#4625), not
  here.
- Error code 10605 from the state transition band.

## 9. Local gate

```
cargo fmt --all
cargo clippy -p dpp -p platform-version -p drive-abci -p rs-dapi -p dash-sdk --all-features --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo test -p platform-version --features mock-versions system_limits
cargo test -p dpp --features all_features admission envelope_kind code_bundle
cargo test -p drive-abci --lib -- decode_raw_state_transitions query::proofs check_tx::v0::tests::contract_code
cargo test -p rs-dapi -- broadcast_state_transition error_mapping
cargo test -p dash-sdk --features mocks -- broadcast admission
```

Estimated diff: about 1,900 lines (the walker and its tests about 900, drive-abci tests about
350, rs-dapi about 250, tables and error about 200, sdk, wasm arm and book about 200). One PR;
the surfaces are one rule seen from five callers and split badly.

## 10. Findings outside this task (for the PR body and the memory pack)

- The unbounded shipped decode (section 2, probe row) is reachable on `v5.0-dev` and on the
  `v4.1.1` release through a 50-byte broadcast; the class is fixed on `v4.2-dev` by #4625, which
  has not been merged forward. The conductor decides how that is escalated; this plan does not
  post it anywhere public.

## 11. Replan checklist (when R06-05 has merged)

1. Confirm the V1 field order and the bundle types in `rs-dpp` match D3; if `code_bundle` is not
   first, move it (D8 note) and refresh the byte-pinning tests.
2. Confirm which basic-structure generations part 2 landed (create v3, update v2) and where the
   module-name predicate lives; import it, do not copy it.
3. Confirm the error names and codes part 2 allocated (10277 to 10282) and that 10605 is still
   free.
4. Confirm whether the `v4.2-dev` forward merge has landed: if the decode entry points are the
   `_untrusted` forms, call those; the walker is unchanged.
5. Confirm `decode_raw_state_transitions` v1 and `proofs_query` v1 are still selected only by an
   unreleased protocol version; otherwise the amendments become v2 generations.
6. Re-check `rs-dapi`'s pre-filter and body-limit constants against the merged part 1 (the review
   on #4717 moved them twice).
