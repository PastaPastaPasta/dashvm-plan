# PLAN SDK-01: specify persistent structs, indexes, rules and entry annotations

Working artifact. Never staged, never committed. Delete when the task ships.

Base: `v4.3-dev` at `d02072827f` (worktree branch `dashvm/sdk-01`). Latest protocol
version in tree: 14 (`LATEST_VERSION = PROTOCOL_VERSION_14`). Toolchain 1.92 with
`wasm32-unknown-unknown`. Release target 4.4-dev; `v4.4-dev` does not exist yet, so
the allocation puts this on `v4.3-dev` and retargets automatically. Tier xhigh.

## 1. Acceptance in my words

SDK-01 is the specification half of the 44-AUTHOR work package (its sibling is CAP-02).
The workstream completion criteria say the two tasks "specify the model and API;
generated persistence, production macros, independent host enforcement and
worked-runtime acceptance remain SDK-02/03/04 and CAP-03 onward in 5.0". This task
therefore lands the declaration model as reviewable, tested code, not proc macros or a
runtime:

1. **Exact developer API for declarations.** The confirmed crate is
   `packages/rs-dash-sdk-contract`, Cargo `dash-sdk-contract`, import
   `dash_sdk_contract`. It carries the attribute grammar (`#[persistent]`,
   `#[singleton]`, `#[index]`, `#[field]`, `#[document_id]`, `#[entry]`, `#[rule]`,
   `#[contract]`/module declarations) as data plus the typed builders
   (`CollectionSpec`, `FieldSpec`, `IndexSpec`, `RuleSpec`, `EntrySpec`,
   `ModuleSpec`, `InterfaceSpec`, `TypedCollectionSpec`) that both the future macros
   (SDK-02) and hand-written declaration modules produce. Attributes and builders feed
   one `ContractDeclaration`; validation yields one `CanonicalManifest`.
2. **Stable identity.** Collections, properties, indexes, methods and interfaces are
   identified by their declared names (plus property position), never by Rust path,
   source module, impl block or declaration order. Moving an entry between named WASM
   modules changes only its module binding. The canonical manifest is order
   independent (sorted by name/position), so two declarations that differ only in
   source order are equal.
3. **Bounded fields.** Every variable-length field (strings, byte arrays, lists) must
   declare an upper bound; integer bounds must fit the declared Rust type. A missing
   bound is a diagnostic, not a default.
4. **Full typed-manifest escape.** The `IndexSpec` builder can express every index
   feature the native catalogue supports today: unique, null searchability,
   contested parameters (field matches, masternode-vote resolution), count/
   offset-count, range count, sum/range sum, average sugar, ranked count/sum/average
   (terminal and prefix levels), time-range buckets, index-only document types with
   terminal/preallocated/skip-if-absent, and every `refersTo` target (identity,
   contract, token, permanent document with property agreement, identity public key).
   Collection-level count/sum/index-only flags and the document-type switches
   (mutable, deletable, keep history, transferable, trade mode, creation restriction,
   security level) are covered too. Capabilities that have no native home yet
   (contract-only writes, native guards, WASM predicates, typed specialized
   collections, ACL, randomness, receipts) are declared through the same model and
   reported as explicit native gaps rather than dropped.
5. **Strict diagnostics.** Unknown attributes/options, invalid option values,
   duplicate/conflicting declarations (attribute and builder describing the same
   thing differently), unbounded fields, identity violations, unknown references
   between declarations, module graph errors, and SDK semantic rules (a `&mut self`
   entry on an immutable collection, `read_only` with a mutable receiver, a singleton
   with indexes) are typed, append-only diagnostics with stable codes. The validator
   never ignores an unrecognized option.
6. **Independent host validation.** `packages/rs-dash-contract-build` translates a
   canonical manifest into the native DPP document schema `Value` and runs the real
   `DataContract::try_from_platform_versioned(.., full_validation = true, ..)` under the
   protocol version in hand. The declarations are thereby reviewable against the
   actual native types; native validation remains the authority, and the SDK
   validator does not duplicate native numeric limits (coding conventions:
   "validation lives once").
7. **Q18.** No index migration or backfill subsystem. The build crate's
   `check_update` runs the existing `DataContract::validate_update` and the tests pin
   that changing/adding/removing an index on an existing collection is rejected
   (`DataContractInvalidIndexDefinitionUpdateError`, validate_update v1) while a new
   collection with indexes is accepted.
8. **Q35.** Persistence semantics are written into the model and the book chapter:
   detached values never save, `insert`/`edit` and successful `&mut self` entry
   wrappers stage writes into the outer transaction, nothing saves on `Drop`. The
   `Receiver::Mut` entry kind is the only implicit staging point and is validated
   against the collection's mutability.
9. **Q36.** Simple attributes plus typed builders, one canonical manifest, conflicting
   or unsupported declarations rejected. The model has no raw path, raw element or
   database-handle type at all.
10. **Q38.** `store = "private"` (private document store) exists in the capability
    catalogue and is rejected by the validator with `CapabilityInterfaceDisabled`
    until encryption, key control, query visibility and proof behaviour are specified.
    Rust field visibility is not part of the model.
11. **Native award acceptance.** `RuleSpec` action scopes are the ordinary document
    actions only (create, replace, delete, transfer, purchase, update price). There is
    no award action; a rule declared `on = "award"` (or any other name) fails with
    `InvalidOptionValue`. Contested indexes are declared only through the supported
    native parameters, and a contested index may coexist with rules on ordinary
    actions. The native award path is untouched and unmentioned in the guest model.
12. **Named modules.** `ContractDeclaration.modules` lists WASM module targets, each
    entry names its module, interfaces declare cross-module functions with a
    provider, and the manifest carries `(importer, provider, export)` bindings with an
    acyclic-graph check, matching the shape the validation crate on `v5.0-dev`
    expects (`BundleInput`, `DeclaredBinding`, entries as `(module, export)`). A
    single-module bundle is valid and needs no module declaration.

Out of scope, by the workstream boundary: proc macros and generated wrappers
(SDK-02), `Context`/query builders/host operations (SDK-02), the worked example with
runtime tests (SDK-03), compatibility reports and version-aware clients (SDK-04), the
ACL/randomness stubs (STUB-ACL/STUB-RNG, which consume the capability declarations
defined here), manifest wire encoding and digests (R08-03/R08-04, allocation A07),
typed collection operation semantics and native adapters (CAP-02/CAP-07), guard AST
canonical encoding and evaluator (R07-01, allocation A12).

## 2. Tree facts that shape the design (drift check)

- No DashVM crate exists on `v4.3-dev`: `packages/` has no `rs-dashvm-*`,
  `rs-dash-sdk-contract`, `rs-dash-contract-*`. R13-01 (PR #4707, `v4.3-dev`) adds the
  alloc-only profiles to `platform-value`/`platform-serialization` in part 1 and will
  create `rs-dashvm-abi` in part 2 (pending). R08-01 (PR #4712, `v5.0-dev`) created
  `rs-dashvm-validation` and the `PlatformVersion.dashvm` table. Neither is on this
  base. This plan depends on neither (section 6).
- The index model is `packages/rs-dpp/src/data_contract/document_type/index/mod.rs`:
  `Index { name, properties: Vec<IndexProperty{name, ascending}>, unique,
  null_searchable, contested_index: Option<ContestedIndexInformation>, countable:
  IndexCountability{NotCountable,Countable,CountableAllowingOffset}, range_countable,
  summable: Option<String>, range_summable, ranked_countable, ranked_countable_at:
  Vec<String>, ranked_summable, ranked_averageable, time_range:
  Option<TimeRangeTransform>, terminal: Option<String>, preallocated, skip_if_absent }`.
  Keywords are admitted per parser generation through `IndexGrammarAdmissions`
  (generation 3 = protocol 14 admits ranked, timeRange, terminal, preallocated,
  skipIfAbsent).
- The document meta-schema v3 (`packages/rs-dpp/schema/meta_schemas/document/v3/
  document-meta.json`, editable until the release carrying protocol 14 ships) admits
  index property order `"asc"` **only** (`enum: ["asc"]`). The API sketch's
  `points = "desc"` index is not expressible natively; query direction is per query.
  Index names are 1..=32 chars, at most 10 indexes per type, at most 10 properties
  per index; property names match `^[a-zA-Z0-9-_]{1,64}$`; at most 100 properties.
  Index-level `dependentRequired`: rangeCountable needs countable, rangeSummable needs
  summable, rangeAverageable needs averageable; ranked* need the matching range*.
- Document type switches available natively: `documentsKeepHistory`,
  `keepsTransferHistory/PurchaseHistory/PricingHistory`, `documentsMutable`,
  `canBeDeleted`, `transferable` (0/1), `tradeMode` (0/1), `creationRestrictionMode`
  (0 none, 1 owner only, 2 system only), `signatureSecurityLevelRequirement` (1..3),
  `requiresIdentity{En,De}cryptionBoundedKey`, `documentsCountable`, `rangeCountable`,
  `documentsSummable`, `rangeSummable`, `documentsAverageable`, `rangeAverageable`,
  `indexOnly`, `tokenCost`. There is no native "contract-only write" mode yet; that is
  R04-03/CAP-02 work in 5.0.
- Property types from a schema (`DocumentPropertyType::try_from_value_map`): `integer`
  (sized to U8..U64/I8..I64 from `minimum`/`maximum`/`enum` when the contract config's
  `sized_integer_types` is true, the V1 default), `string` (`minLength`/`maxLength`
  as u16), `array` only with `byteArray: true` (`minItems`/`maxItems`; identifier
  when `contentMediaType: application/x.dash.dpp.identifier`), `object` (nested
  properties each need `position`), `boolean`, `number` (F64). `refersTo` on
  identifier properties: identity, contract, token, permanentDocument
  `{contractId?, documentType, propertyAgreement?}`, identityPublicKey
  `{keyIdProperty}`. `requiredSince` is a property keyword (contract version stamps).
  Indexed strings are capped at 63 chars and indexed byte arrays at 255 bytes
  (`MAX_INDEXED_*` in `try_from_schema/common/mod.rs`); positions must be contiguous
  from 0 under full validation.
- Document type names: `validate_document_type_name` accepts ASCII alphanumerics,
  `_`, `-`, 1..=64 chars.
- Native update rules: `DataContract::validate_update` (dispatch on
  `contract_versions.methods.validate_update`, v1 at protocol 14) runs
  `validate_update_existing_document_types`, whose document-type v1 rejects any
  added/removed/changed index by name (`DataContractInvalidIndexDefinitionUpdateError`)
  and freezes byte-array encodings and top-level requiredness. New document types are
  parsed by the new contract's full validation and are not compared. This is the
  "inspected v1 validator" the owner cites in Q18. `validate_update` is behind the
  `dpp` feature `validation`.
- Construction API for the build crate: `DataContractInSerializationFormatV1 { id,
  config, version, owner_id, schema_defs, document_schemas, created_at.., groups,
  tokens, keywords, description }` then `DataContract::try_from_platform_versioned(
  format, full_validation, &mut Vec<ProtocolValidationOperation>, platform_version)`.
  `DataContractConfig::default_for_version(pv)`. `enrich_with_base_schema` injects
  `$schema` so the author schema does not carry it (DPNS's documents JSON has none).
- CI: new members must be added to `.github/package-filters/rs-packages.yml` and
  `rs-packages-no-workflows.yml`, and to the nextest `--package` list in
  `.github/workflows/tests-rs-workspace.yml` (R08-01 did exactly this). `cargo clippy
  --workspace --all-targets --all-features -- -D warnings` and `cargo machete` run on
  every PR. The "Check transport-free feature cuts" step is the model for a guest cut.
- Adding a workspace member on cargo 1.92 rewrites unrelated `Cargo.lock` entries
  (itertools/heck under bindgen, criterion, prost-build); expected, explained in the
  PR body, `cargo metadata --locked` still passes.
- `thiserror 2.0.17`, `proc-macro2`, `syn 2`, `quote` are in the lock; `trybuild` is
  not (not needed: no macros here). `sha2` is present but not needed (no digest here).
- The shared `CARGO_TARGET_DIR=/Users/dashvm/work/target` collides on
  `platform-version` fingerprints when other lanes edit it; use a private target dir
  for the workspace check and delete it afterwards (102 GiB free).

## 3. Approach

Two sequential parts, both new crates, no edits to DPP, Drive, platform-version,
protos or SDK surfaces. Part 1 is the guest-facing declaration model and compiles
alone. Part 2 is the native translation and host-validation evidence and depends on
part 1. Each passes CI on its own.

### Part 1: `dash-sdk-contract` declaration model, grammar, identity, diagnostics, manifest

#### `packages/rs-dash-sdk-contract/Cargo.toml`

```toml
[package]
name = "dash-sdk-contract"
version.workspace = true
edition = "2021"
rust-version.workspace = true
authors = ["Dash Core Team"]
license = "MIT"
description = "Contract-author SDK for DashVM: declaration model, attribute grammar, diagnostics and canonical manifest"

[dependencies]
thiserror = { version = "2.0.17", default-features = false }

[features]
default = ["std"]
std = ["thiserror/std"]
```

Guest-safe by construction: `#![cfg_attr(not(feature = "std"), no_std)]`,
`#![forbid(unsafe_code)]`, `#![deny(missing_docs)]`, `extern crate alloc`. No
`platform-value`, `platform-version`, `dpp`, `drive`, client or engine dependency. The
crate's future `dashvm-abi` dependency (per the crate map) arrives when R13-01 part 2
and R08-03/R08-04 give the manifest a wire encoding; nothing here needs it yet.

Added to the root workspace `members` after `packages/rs-dash-platform-macros`.
`rust-toolchain.toml` gains `"wasm32v1-none"` in `targets` (a no-std-library target
so a std leak is a compile error; R13-01 part 1 adds the identical line, which merges
cleanly).

#### Module layout (AUTHOR catalog names where they apply)

```text
src/lib.rs            crate docs: what is specified here, what SDK-02/03/04 implement
src/prelude.rs        re-exports of the declaration types and builders
src/identity.rs       CollectionName, PropertyName, PropertyPath, IndexName,
                      MethodName, ModuleName, InterfaceName newtypes + rules
src/grammar.rs        attribute grammar as data + key checking
src/declare/mod.rs    ContractDeclaration, builders' entry point
src/declare/collection.rs   CollectionSpec, CollectionKind, WritePolicy, switches
src/declare/field.rs        FieldSpec, FieldType, IntegerBounds, ReferenceTarget
src/declare/index.rs        IndexSpec, IndexProperty, Countability, Summation,
                            Ranking, TimeRangeSpec, ContestedSpec, IndexOnlySpec
src/declare/rule.rs         RuleSpec, ActionScope, RuleKind, GuardExpr (provisional)
src/declare/entry.rs        EntrySpec, Receiver, ParamSpec, ValueType
src/declare/module.rs       ModuleSpec, InterfaceSpec, InternalFunctionSpec
src/declare/collections.rs  TypedCollectionSpec, TypedCollectionKind (slot for CAP-02)
src/declare/capability.rs   CapabilityRequirement, CapabilityStatus catalogue,
                            ReceiptPolicy
src/validate/mod.rs   validate(&ContractDeclaration) -> Result<CanonicalManifest, Vec<Diagnostic>>
src/validate/diagnostic.rs  Diagnostic (append-only, stable codes), DeclarationPath
src/validate/{names,collections,indexes,entries,modules,rules,capabilities}.rs
src/manifest/mod.rs   CanonicalManifest (sorted, order independent)
src/manifest/bundle.rs      ModuleTable, Binding, EntryBinding
src/manifest/method.rs      MethodTable, MethodEntry
src/manifest/capability.rs  CapabilityTable
src/persistence.rs    the persistence semantics as documented constants/enums
                      (StagingPoint::{ExplicitInsert, ExplicitEdit, MutReceiverOk};
                      no Drop, no detached save) consumed by SDK-02 codegen
README.md
```

`manifest/` is the provisional home of the canonical manifest shape (the ABI module
owns "immutable bundle/method descriptors"). It has no SDK-specific dependencies so
it can move to `dashvm_abi::manifest` (with a re-export from this crate) when R08-03
allocates the encoding. Same pattern R08-01 used for its bundle descriptors.

#### `identity.rs`

| Newtype | Grammar | Source of the rule |
|---|---|---|
| `CollectionName` | `^[a-zA-Z0-9_-]{1,64}$` | native `validate_document_type_name` |
| `PropertyName` | `^[a-zA-Z0-9_-]{1,64}$` | meta-schema `documentProperties.propertyNames` |
| `PropertyPath` | dotted `PropertyName`s, depth bounded by nesting | index `propertyNames.maxLength 256` |
| `IndexName` | 1..=32 chars, any UTF-8 | meta-schema `indices.items.name` |
| `MethodName` | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, 1..=64 bytes (provisional) | SDK rule; `score.add` shape from the sketch |
| `ModuleName` | `^[a-z0-9_]{1,64}$` (provisional) | matches the validation crate's `ModuleName` on v5.0-dev; the 64 mirrors `max_module_name_bytes` |
| `InterfaceName` | same as `ModuleName` (provisional) | SDK rule |

Identity rules (doc'd on the types and in the book): a collection's identity is its
name; a property's identity is `(collection, path, position)`; an index's identity is
`(collection, index name)`; a method's identity is its `MethodName`, unique
contract-wide across all modules; an interface's identity is its name. Rust idents,
impl blocks, source files and modules never enter the manifest. The wire/numeric IDs
for methods and types are R08-04's allocation (A07); this crate defines only the
names they are derived from. `entry_export_symbol(&MethodName) -> String` gives the
WASM export name `dash_entry_<name with '.' replaced by "__">` (provisional, A24) so
that the manifest can bind `(module, export)` the way the validation crate's entries
expect.

#### `grammar.rs`

The attribute grammar as data so that SDK-02's proc macros, this crate's validator and
the book table cannot drift:

```rust
pub struct AttributeSpec { pub name: &'static str, pub target: AttributeTarget, pub keys: &'static [KeySpec] }
pub struct KeySpec { pub name: &'static str, pub value: KeyValue, pub required: bool }
pub enum AttributeTarget { Struct, Field, Function, Module }
pub enum KeyValue { Flag, Str, Int, StrList, Nested(&'static [KeySpec]) }
pub const ATTRIBUTES: &[AttributeSpec] = &[ /* persistent, singleton, index, field, document_id, entry, rule, contract, module, uses */ ];
pub fn check_keys(attribute: &str, given: &[(&str, KeyValueKind)]) -> Vec<Diagnostic>;
```

Attribute table (the grammar SDK-02 implements; values are `KeyValue` kinds):

| Attribute | Target | Keys |
|---|---|---|
| `persistent` | struct | `collection` (Str, required), `schema` (Int, default 1), `write` (Str: `any`/`owner`/`contract`, default `any`), `mutable` (Flag, default true), `deletable` (Flag, default true), `keep_history` (Flag), `transferable` (Flag), `trade` (Str: `none`/`direct_purchase`), `security_level` (Str: `critical`/`high`/`medium`), `countable` (Flag), `range_countable` (Flag), `summable` (Str), `range_summable` (Flag), `index_only` (Flag), `store` (Str: `public`/`private`) |
| `singleton` | struct | `collection` (Str, required), `schema`, `write`, `security_level`, `store` |
| `index` | struct, repeatable | `name` (Str, required), `fields` (Nested: `<property> = "asc"`, required), `unique`, `null_searchable` (Flag, default true), `contested` (Nested: `field_matches` list of `<field> = "<regex>"`, `resolution = "masternode_vote"`, `description`), `count` (Flag) or `count = "offset"`, `range_count`, `sum` (Str), `range_sum`, `average` (Str), `range_average`, `ranked_count` (Flag or `ranked_count = ["prefix", ...]`), `ranked_sum`, `ranked_average`, `time_range` (Nested: `on`, `range_secs`, `step_secs`, `phase_secs`), `terminal` (Str), `preallocated`, `skip_if_absent` |
| `field` | field | `position` (Int, required), `max_chars`, `min_chars`, `max_len`, `min_len`, `min`, `max`, `required` (Flag, default true), `transient`, `refers_to` (Str: `identity`/`contract`/`token`/`permanent_document`/`identity_public_key`), `document_type`, `contract`, `agreement` (Nested), `key_id_field` |
| `document_id` | field | none |
| `entry` | fn | `name` (Str, required), `read_only` (Flag), `module` (Str, default the single module) |
| `rule` | struct, repeatable | `name`, `on` (StrList of ordinary actions, required), `guard` (Str: a named `GuardExpr` const) or `predicate` (Str: `module::export`) |
| `contract` | crate/module | `receipts` (Str: `stored`/`disabled`, default stored), `requires` (StrList: `acl`, `randomness`) |
| `module` | module | `name` (Str, required), `uses` (StrList of interfaces) |

Unknown attribute or key: `Diagnostic::UnknownAttribute` / `UnknownOption`; wrong
value kind: `InvalidOptionValue`; repeated key: `DuplicateOption`; missing required:
`MissingOption`. The API sketch's `fields(points = "desc")` therefore fails with
`InvalidOptionValue` naming the native ascending-only rule; this is recorded as a
sketch correction in the book.

#### `declare/*`

`ContractDeclaration { modules: Vec<ModuleSpec>, interfaces: Vec<InterfaceSpec>,
collections: Vec<CollectionSpec>, typed_collections: Vec<TypedCollectionSpec>,
entries: Vec<EntrySpec>, rules: Vec<RuleSpec>, capabilities:
Vec<CapabilityRequirement>, receipts: ReceiptPolicy }` with `Default` and fluent
builders (`.collection(spec)`, `.entry(spec)` ...). Each spec records `origin:
DeclarationOrigin::{Attribute, Builder}` so the validator can name the two sources of
a conflict.

`CollectionSpec { name, kind: CollectionKind::{Documents, Singleton}, schema_revision:
u32 (>= 1, provisional meaning: author-declared schema revision recorded for SDK-04's
compatibility report), write: WritePolicy::{Any, Owner, Contract}, mutable, deletable,
keep_history, transferable: bool, trade: TradeMode::{None, DirectPurchase},
security_level: SecurityLevel::{Critical, High, Medium}, countable, range_countable,
summable: Option<PropertyName>, range_summable, index_only, store: Store::{Public,
Private}, document_id_field: Option<FieldName>, fields: Vec<FieldSpec>, indexes:
Vec<IndexSpec> }`. `WritePolicy::Any` maps to native creation restriction 0, `Owner`
to 1, `Contract` to the pending native contract-write authority (R04-03/CAP-02),
which the build crate reports as `NativeGap::ContractWrites`.

`FieldSpec { name: PropertyName, position: u32, ty: FieldType, required: bool,
transient: bool, description: Option<String> }`. `FieldType`: `Bool`, `U8..U64`,
`I8..I64` each with `IntegerBounds { min: Option<i64>, max: Option<i64> }`, `F64`,
`String { min_chars: Option<u16>, max_chars: u16 }`, `Bytes { min_len: Option<u16>,
max_len: u16 }`, `Identifier`, `Reference(ReferenceTarget)`, `Enum(EnumValues)`,
`Object(Vec<FieldSpec>)`. `ReferenceTarget::{Identity, Contract, Token,
PermanentDocument { contract: Option<[u8; 32]>, document_type: CollectionName,
agreement: Vec<(PropertyName, PropertyName)> }, IdentityPublicKey { key_id_field:
PropertyName }}`. The doc on each integer variant states the native sized type DPP
infers from the bounds (part 2 pins it with a test).

`IndexSpec { name: IndexName, properties: Vec<PropertyPath> (ascending), unique,
null_searchable, contested: Option<ContestedSpec { field_matches: Vec<(PropertyPath,
String)>, resolution: ContestedResolution::MasternodeVote, description:
Option<String> }>, count: Countability::{None, Count, CountAllowingOffset}, range_count,
sum: Option<PropertyName>, range_sum, ranked: Ranking { count: RankedCount::{None,
Terminal, At(Vec<PropertyName>)}, sum: bool, average: bool }, time_range:
Option<TimeRangeSpec { on: PropertyPath, range_secs: u64, step_secs: u64, phase_secs:
u64 }>, index_only: Option<IndexOnlySpec { terminal: Option<PropertyPath>,
preallocated, skip_if_absent }> }`. `average = "p"` in the grammar expands to
`count = Count` plus `sum = "p"` at parse time (native sugar semantics); the manifest
stores the expanded form. Combinations native rejects (range count without count,
ranked without range, prefix ranking with sum axes, time range with ranking) are not
re-validated here; the build crate surfaces the native error.

`RuleSpec { name: Option<String>, collection: CollectionName, actions:
Vec<ActionScope::{Create, Replace, Delete, Transfer, Purchase, UpdatePrice}>, kind:
RuleKind::{NativeGuard(GuardExpr), WasmPredicate { module: ModuleName, export: String }}
}`. `GuardExpr` is the author-facing form of the DVM-05 proposed node set (`Literal`,
`Field(Old|New|Context, PropertyPath)`, `Exists`, `IsNull`, `Eq`, `Ne`, `Lt`, `Le`,
`Gt`, `Ge`, `Add`, `Sub`, `Mul`, `And`, `Or`, `Not`, `If`), marked provisional: DPP's
canonical AST (R07-01, allocation A12) is the authority and the build crate will
translate to it in 5.0. No award scope exists in `ActionScope`.

`EntrySpec { name: MethodName, module: Option<ModuleName>, receiver: Receiver::{None,
Ref(CollectionName), Mut(CollectionName)}, read_only: bool, params: Vec<ParamSpec {
name: String, ty: ValueType }>, returns: ValueType }`. `ValueType` = `FieldType`
variants plus `Unit`, `DocumentId`, `Option(Box)`, `List { max_len: u32, item: Box }`,
`Struct(Vec<(String, ValueType)>)` (embedded bounded value structs such as the sketch's
`ClassSummary`). A receiver entry takes the target `DocumentId` as its first wire
argument; the wrapper loads exactly that record (documented in `persistence.rs`).

`ModuleSpec { name: ModuleName, uses: Vec<InterfaceName> }`, `InterfaceSpec { name,
provider: ModuleName, functions: Vec<InternalFunctionSpec { name, params, returns }> }`.
When `modules` is empty the manifest has one implicit module named `main`
(provisional) and every entry binds to it.

`TypedCollectionSpec { id: CollectionName, kind: TypedCollectionKind::{Sum, BigSum,
Count, CountSum, ProvableSum, ProvableCount, Ranked, Append (MMR), Commitment}, key:
ValueType, element: ValueType, max_elements: Option<u64> }`. This is the manifest slot
only; operation sets, limits, privacy model and native adapters are CAP-02/CAP-07. The
catalogue marks every kind `PendingNative`.

`CapabilityRequirement::{Acl, Randomness}` plus the derived requirements the validator
computes (`ContractWrites`, `NativeGuards`, `WasmPredicates`, `TypedCollections`,
`PrivateStore`, `StoredReceipts`). `CapabilityStatus::{Native, PendingNative,
InterfaceDisabled}` per requirement, the catalogue table used by both the validator
(`InterfaceDisabled` is rejected: Q38) and the build crate (`PendingNative` becomes a
`NativeGap`). `ReceiptPolicy::{Stored, Disabled}` default `Stored` (Q32).

#### `validate/*`

`validate(&ContractDeclaration) -> Result<CanonicalManifest, Vec<Diagnostic>>` runs
every check and collects all diagnostics (no first-error return). `Diagnostic` is an
append-only enum with `fn code(&self) -> &'static str` (`DSC0001`.. provisional) and
`fn path(&self) -> &DeclarationPath`, `Display` for humans. Variants and the rule each
enforces:

| Diagnostic | Rule |
|---|---|
| `UnknownAttribute`, `UnknownOption`, `InvalidOptionValue`, `MissingOption`, `DuplicateOption` | grammar |
| `ConflictingDeclaration { first: DeclarationOrigin, second }` | attribute and builder declare the same collection/index/entry/rule differently |
| `DuplicateCollection`, `DuplicateIndex`, `DuplicateMethod`, `DuplicateModule`, `DuplicateInterface`, `DuplicateProperty`, `DuplicatePosition` | identity uniqueness |
| `NonContiguousPositions` | positions are 0..n at every nesting level (the macro never renumbers) |
| `InvalidName { kind, name }` | identity grammar table |
| `UnboundedField` | every `String`/`Bytes`/`List` declares a maximum |
| `IntegerBoundsOutsideType` | `min`/`max` fit the declared integer type and `min <= max` |
| `IndexPropertyUnknown`, `SummablePropertyUnknown`, `ContestedFieldNotIndexed`, `TimeRangeSourceNotFirst`, `TerminalNotAProperty` | cross-references inside a collection |
| `IndexOnlyOptionOnStoredCollection` | `terminal`/`preallocated`/`skip_if_absent` need `index_only` |
| `SingletonWithIndexes`, `SingletonWithDocumentIdField`, `MissingDocumentIdField` | collection kind rules |
| `ReceiverCollectionUnknown`, `MutableReceiverOnImmutableCollection`, `ReadOnlyEntryWithMutableReceiver`, `ReceiverOnSingletonTakesNoId` | entry semantics (Q35 staging point exists only where the collection is mutable) |
| `EntryModuleUnknown`, `InterfaceProviderUnknown`, `InterfaceNotProvided`, `ModuleSelfImport`, `ModuleGraphCycle`, `PredicateExportUnknown` | named-module graph |
| `RuleCollectionUnknown`, `RuleWithoutActions` | rule scope (award is unrepresentable; `on = "award"` is `InvalidOptionValue`) |
| `CapabilityInterfaceDisabled(PrivateStore)` | Q38 |
| `RawPathDeclaration` | reserved: never produced; documents that no path/handle grammar exists (Q36) |

Deliberately absent: mirrors of native numeric limits (10 indexes, 32-char index
names, 63-char indexed strings, 100 properties, time-range overlap cap 24) and native
schema dependencies (range count needs count, ranked needs range). Those are enforced
once, by DPP, and surfaced by part 2. The book states this split.

#### `manifest/*`

`CanonicalManifest { modules: ModuleTable (sorted by name; bindings sorted
(importer, provider, export)), collections: Vec<CollectionManifest> (sorted by name;
fields by position; indexes by name), typed_collections (by id), methods: MethodTable
(sorted by `MethodName`; each `MethodEntry { name, module, export, receiver,
read_only, params, returns }`), rules (by collection, then name), capabilities:
CapabilityTable (sorted), receipts }`. `PartialEq + Eq + Clone + Debug`. Construction
only through `validate`. No encoding, no digest (R08-03/R08-04). Two declarations that
differ in source order, in attribute-versus-builder origin, or in which module an
entry lives in (other than the binding itself) produce equal manifests / equal
identity sets; tests pin this.

#### `persistence.rs`

Documented enums consumed by SDK-02 codegen and the book: `StagingPoint::{ExplicitInsert,
ExplicitEdit, MutReceiverOnOk}`; `NeverStages::{DetachedValue, Drop, EscapedReference,
UnmarkedHelper}`; `HostManaged::{DocumentId, Revision, Owner, StorageFlags}`. Small,
but it makes Q35 a compile-visible contract rather than prose only.

#### Tests (part 1, beside implementations)

- `grammar`: every attribute in the book table is in `ATTRIBUTES` (a test iterates a
  literal copy of the table); unknown attribute/key/value/duplicate/missing each
  produce their diagnostic; `fields(x = "desc")` is `InvalidOptionValue`;
  `rule(on = "award")` is `InvalidOptionValue`.
- `identity`: each newtype accepts its boundary values and rejects one over/invalid
  character; `entry_export_symbol("score.add") == "dash_entry_score__add"`.
- `validate`: one test per `Diagnostic` variant that can be produced (a
  `should_report_<variant>` naming convention), and the API sketch's `Score` contract
  (with `points = "asc"` and `write = "owner"`) validating to a manifest; the sketch
  with `write = "contract"` validating with the derived `ContractWrites` requirement.
- `manifest`: order independence (shuffled declarations, same manifest); module move
  (entry moved from `main` to `helpers` keeps the same `MethodName` set and method
  identities, differs only in bindings); singleton and typed-collection slots
  round-trip.
- `alloc` profile: `tests/alloc_profile.rs` compiled only with default features off
  (`#![cfg(not(feature = "std"))]` guard is not possible for an integration test, so
  the test is a plain test that builds the sketch through builders; the CI cut runs
  it under `--no-default-features`).

#### Repository plumbing (part 1)

- `Cargo.toml` members + `Cargo.lock` (expect unrelated bumps; explain in PR body).
- `rust-toolchain.toml`: add `wasm32v1-none`.
- `.github/package-filters/rs-packages.yml` and `rs-packages-no-workflows.yml`: new
  `dash-sdk-contract` filter; `.github/workflows/tests-rs-workspace.yml`: add
  `--package dash-sdk-contract` to the nextest list and a "Check guest declaration
  cut" step: `cargo check -p dash-sdk-contract --no-default-features --target
  wasm32v1-none --locked` and `cargo test -p dash-sdk-contract --no-default-features
  --locked`.
- `packages/check-features/src/main.rs`: add `("rs-dash-sdk-contract", vec![])`.
- `book/src/SUMMARY.md`: new section `# DashVM` with `- [Contract Declarations and
  the Author API](dashvm/contract-declarations.md)`; new chapter
  `book/src/dashvm/contract-declarations.md` (the grammar table, identity rules,
  bounded fields, persistence semantics, index update rule, rule scopes and native
  awards, capability catalogue status, named modules, mapping to native keywords,
  what is provisional, what SDK-02/03/04 add). `book/src/contributing/
  coding-conventions.md` gets one table row: "A contract-author declaration or
  diagnostic | `packages/rs-dash-sdk-contract` | builds for `wasm32v1-none` with
  `--no-default-features`; native limits are not duplicated there, they surface
  through `dash-contract-build`".

### Part 2: `dash-contract-build` native translation and independent host validation

#### `packages/rs-dash-contract-build/Cargo.toml`

```toml
[package]
name = "dash-contract-build"
version.workspace = true
edition = "2021"
rust-version.workspace = true
authors = ["Dash Core Team"]
license = "MIT"
description = "Native build support for DashVM contracts: translate canonical manifests to Platform document schemas and validate them with DPP"

[dependencies]
dash-sdk-contract = { path = "../rs-dash-sdk-contract" }
dpp = { path = "../rs-dpp", features = ["validation"] }   # validate_update is behind `validation`; defaults kept
platform-value = { path = "../rs-platform-value" }
platform-version = { path = "../rs-platform-version" }
thiserror = "2.0.17"
```

Native only (std). Not a guest dependency. Added to the workspace, filters and nextest
list like part 1. No `dashvm-validation` dependency yet (that crate is on `v5.0-dev`;
the build crate's `build.rs`/artifact/codegen/estimate modules are R13-06/SDK-03 work).

#### Modules (BUILD catalog names)

```text
src/lib.rs
src/schema.rs        to_document_schema(&CollectionManifest) -> platform_value::Value
                     (the exact JSON-schema shape try_from_schema generation 3 parses)
src/manifest.rs      to_serialization_format(&CanonicalManifest, owner_id, contract_id, version, pv)
                     -> DataContractInSerializationFormatV1 with default config
src/native.rs        validate_natively(&CanonicalManifest, &PlatformVersion) -> NativeValidation
                     check_update(old: &CanonicalManifest, new: &CanonicalManifest, &PlatformVersion) -> UpdateValidation
src/gaps.rs          NativeGap::{ContractWrites, NativeGuard, WasmPredicate, TypedCollection(kind),
                     Capability(Acl|Randomness), Receipts, Entries, Modules}
src/error.rs         BuildError (translation failures are internal errors: the SDK validator
                     should have rejected the input)
README.md
```

`schema.rs` mapping table (declaration -> native keyword), also printed in the book:

| Declaration | Native document schema |
|---|---|
| `CollectionSpec.name` | document type name (key of `document_schemas`) |
| `mutable`, `deletable`, `keep_history`, `transferable`, `trade`, `security_level` | `documentsMutable`, `canBeDeleted`, `documentsKeepHistory`, `transferable` 0/1, `tradeMode` 0/1, `signatureSecurityLevelRequirement` 1/2/3 |
| `write: Any / Owner` | `creationRestrictionMode` 0 / 1; `Contract` -> `NativeGap::ContractWrites` (schema emitted with 0 so the rest still validates; the gap is reported) |
| `countable`, `range_countable`, `summable`, `range_summable`, `index_only` | `documentsCountable`, `rangeCountable`, `documentsSummable`, `rangeSummable`, `indexOnly` |
| `FieldSpec` integers | `type: integer` + `minimum`/`maximum` (DPP sizes the storage type) |
| `String { min_chars, max_chars }` | `type: string`, `minLength`, `maxLength` |
| `Bytes { .. }` | `type: array`, `byteArray: true`, `minItems`, `maxItems` |
| `Identifier` | `type: array`, `byteArray: true`, `minItems: 32`, `maxItems: 32`, `contentMediaType: application/x.dash.dpp.identifier` |
| `Reference(target)` | identifier shape + `refersTo: { type, contractId?, documentType?, propertyAgreement?, keyIdProperty? }` |
| `Enum`, `Object`, `F64`, `Bool` | `enum`, `type: object` + nested `properties`/`additionalProperties: false`, `type: number`, `type: boolean` |
| `position`, `required`, `transient` | `position`, `required` array, `transient` array |
| `IndexSpec` | one `indices` entry: `name`, `properties: [{p: "asc"}]`, `unique`, `nullSearchable`, `contested: { fieldMatches: [{field, regexPattern}], resolution: 0, description }`, `countable` (`"countable"`/`"countableAllowingOffset"`), `rangeCountable`, `summable`, `rangeSummable`, `rankedCountable` (`true` or `{ at: [..] }`), `rankedSummable`, `rankedAverageable`, `timeRange: { on, range, step, phase }`, `terminal`, `preallocated`, `skipIfAbsent` |
| `SingletonSpec` | ordinary document type; the reserved key is host/SDK behaviour (SDK-02), not schema |
| `RuleSpec`, `EntrySpec`, `ModuleSpec`, `TypedCollectionSpec`, `Acl`/`Randomness`, `ReceiptPolicy` | no native representation at protocol 14: `NativeGap` entries |

Public reachability verified on this tree: `dpp::data_contract::serialized_version` is
`pub mod`, `DataContractInSerializationFormatV1` and the enum are `pub`,
`DataContract::try_from_platform_versioned` is `pub` and unconditional,
`DataContract::validate_update` (trait `DataContractUpdateValidationMethodsV0`) needs
the `validation` feature, `DataContractConfig::default_for_version` is `pub`,
`BlockInfo` derives `Default`. The `factories` feature is not needed.

`native.rs`: `validate_natively` builds the V1 serialization format (config
`DataContractConfig::default_for_version`, version 1, zero owner id and a derived
contract id), calls `DataContract::try_from_platform_versioned(format, true, &mut
ops, pv)`, and returns `NativeValidation { accepted: Result<(), Vec<String>>
(consensus/protocol error text), gaps: Vec<NativeGap>, validation_operations:
Vec<ProtocolValidationOperation> }`. `check_update` builds both contracts (new at
`version + 1`) and runs `DataContract::validate_update(&new, &BlockInfo::default(),
pv)` returning the `SimpleConsensusValidationResult` errors. Nothing here decides
acceptance itself; it reports what DPP said.

#### Tests (part 2)

All under `PlatformVersion::latest()` (latest-generation rule), in
`src/native.rs`/`src/schema.rs` test modules and `tests/catalogue.rs`:

- **Catalogue matrix accepted natively**: a generator producing one collection per
  supported index shape (plain, unique, `null_searchable = false`, contested unique,
  count, offset count, count + range count, sum, sum + range sum, average sugar,
  ranked count terminal, ranked count at a prefix on a two-property index, ranked
  sum, ranked average, time range on `$createdAt` (unique with range == step and
  non-unique overlapping), index-only with default terminal, index-only with
  `terminal = <refersTo identity property>`, index-only preallocated with a same
  contract permanent-document reference and property agreement, index-only
  `skip_if_absent`, each `refersTo` target on a plain index), plus collection-level
  count/sum/index-only. Each translates and is accepted by DPP full validation with
  zero gaps.
- **Sized integer inference**: `I64 { min: 0, max: 1_000_000 }` parses to
  `DocumentPropertyType::U32`; `I64 { min: -1, max: 1 }` to `I8`; unbounded to
  `I64`; asserted through the parsed contract's document type properties so the
  book's statement is pinned.
- **Native remains the authority**: raw `Value` schemas that bypass the SDK validator
  (11 indexes, 33-char index name, `"desc"`, indexed 64-char string, range count
  without count, ranked without range, prefix ranking with a sum axis, time range on
  a user property) are rejected by DPP; the test names the native error for each, so
  the split "SDK grammar vs native limits" is evidence-backed.
- **Q18**: `check_update(old, new)` where `new` changes an index's properties, adds
  an index, removes an index on an existing collection: each rejected with
  `DataContractInvalidIndexDefinitionUpdateError` naming the index; `new` that adds a
  collection with two indexes (one contested unique): accepted; `new` that reorders
  the `indices` array only: accepted (semantic no-op, validate_schema_compatibility
  v1 strips `indices`).
- **Gaps**: the sketch with `write = "contract"`, a native guard rule, a WASM
  predicate rule, a typed sum collection, `requires = ["acl"]`, and two entries
  reports exactly `{ContractWrites, NativeGuard, WasmPredicate, TypedCollection(Sum),
  Capability(Acl), Entries, Modules}` while the document schemas are still accepted.
- **Contested parameters**: contested field match on a non-index property and
  resolution other than 0 rejected natively; supported parameters accepted; a rule
  on `Create` next to a contested unique index validates (Q09 coexistence).

### What stays byte-identical

Everything that exists: no DPP, Drive, ABCI, platform-version, proto, wasm, SDK or
mobile file changes. No protocol version table, `SystemLimits`, fee schedule or
consensus error is added or edited. No `!` in titles. The meta-schema v3 is read, not
modified. Cargo.lock changes are the two new members plus resolver churn.

## 4. Decisions and provisional values (go in the PR bodies)

1. **Two new crates now, no macros.** Production macros are SDK-02 by the workstream
   boundary; SDK-01 lands the grammar as data plus the model, validator and manifest
   they target. Proc-macro crate `rs-dash-contract-macros` is created by SDK-02.
2. **Canonical manifest lives provisionally in `dash-sdk-contract::manifest`**, not in
   `dashvm-abi` (that crate is R13-01 part 2, pending, and its manifest encoding is
   R08-03/R08-04). The module has no SDK-only dependencies so it can move with a
   re-export. Same precedent as the validation crate's bundle descriptors.
3. **No dependency on R13-01, CAP-01 or CAP-02.** The declaration crate needs only
   `alloc` and `thiserror`; the build crate is native and uses today's DPP. The
   44-AUTHOR package prerequisites (43-PLAN, 44-CODEC, 44-GROVE) are sequencing
   guidance, not task edges; nothing here touches their files or symbols.
4. **Index property order is ascending only** (native meta-schema v3). The API
   sketch's `points = "desc"` is corrected in the book; direction is a query choice.
5. **The SDK validator owns grammar, identity, boundedness, conflicts and SDK
   semantics; native numeric limits and schema dependencies are not duplicated** and
   surface through `dash-contract-build` running DPP. This follows the coding
   convention that validation lives once, while still giving "strict diagnostics"
   for everything native cannot know (attribute misuse, Rust-side conflicts).
6. **`write = "contract"` is a pending native capability** (`NativeGap::ContractWrites`;
   R04-03/CAP-02 own the native permission). The translation emits creation
   restriction 0 so the remainder of the schema still validates.
7. **`schema = N` means an author-declared schema revision (>= 1)** recorded in the
   manifest for SDK-04's compatibility report. Provisional.
8. **Name grammars**: `ModuleName` `^[a-z0-9_]{1,64}$` (aligned to the validation
   crate on v5.0-dev and `max_module_name_bytes = 64`), `MethodName`
   `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` up to 64 bytes, export symbol
   `dash_entry_<name with . -> __>`, implicit single module `main`. All provisional
   under allocation A24; numeric method/type IDs stay with A07 (R08-04).
9. **`GuardExpr` mirrors the DVM-05 proposed node set** as author-facing declaration
   only; DPP's canonical AST (R07-01, A12) is the authority; no evaluator here.
10. **Typed specialized collections are a manifest slot** (`TypedCollectionSpec` with
    the catalogue kinds); operation sets, limits, privacy and native adapters remain
    CAP-02/CAP-07. Every kind is `PendingNative`.
11. **Private store stays catalogued and disabled** (`CapabilityInterfaceDisabled`,
    Q38). Rust visibility is not modelled.
12. **Diagnostic codes `DSC0001..`** are provisional stable strings; the enum is
    append-only.
13. **`wasm32v1-none`** in `rust-toolchain.toml` for the guest cut (same line R13-01
    part 1 adds; identical hunks merge cleanly). If the CI runner cannot install it,
    fall back to `wasm32-unknown-unknown` for the check and note the weaker guarantee.
14. **Book chapter** `book/src/dashvm/contract-declarations.md` under a new `# DashVM`
    section; R08-01 part 2 adds a chapter in the same directory on v5.0-dev, so the
    merge-forward will union the section.

## 5. Versioning consequences

None. No new `vN`, no table edits, no fee schedule, no consensus error codes, no
proto or SDK surface changes. Tests pin behaviour at `PlatformVersion::latest()`
through the DPP dispatchers.

## 6. Dependencies

`depends_on` is empty and stays empty. Checked and not needed: R13-01 (files
`packages/rs-platform-value/**`, `packages/rs-platform-serialization/**`, future
`packages/rs-dashvm-abi`; none imported here), CAP-01 (GroveDB pin; untouched),
CAP-02 (typed capability semantics; only a manifest slot is defined here, and the
split is stated), R08-01 (`packages/rs-dashvm-validation`, `PlatformVersion.dashvm`;
only name grammars are aligned by value, no import). Nothing blocks.

## 7. Size, tier, base

- Part 1: about 3,900 lines (model ~1,300, grammar ~300, validator ~900, manifest
  ~350, tests ~800, book ~250, plumbing) plus Cargo.lock.
- Part 2: about 2,200 lines (schema ~450, native ~250, gaps/error ~150, tests
  ~1,200, README/book mapping ~150) plus Cargo.lock.
- Total about 6,100. Tier stays xhigh (new public author API, reviewed against native
  types; no consensus code touched).
- Base `v4.3-dev` for both parts (4.4-dev allocation; branch not yet cut).

## 8. Local gate (per part)

```bash
cargo fmt --all
cargo clippy -p dash-sdk-contract --all-features --all-targets -- -D warnings
cargo clippy -p dash-sdk-contract --no-default-features --all-targets -- -D warnings
cargo check -p dash-sdk-contract --no-default-features --target wasm32v1-none
cargo test -p dash-sdk-contract
cargo test -p dash-sdk-contract --no-default-features
# part 2 adds
cargo clippy -p dash-contract-build --all-features --all-targets -- -D warnings
cargo test -p dash-contract-build
# both parts
CARGO_TARGET_DIR=/Users/dashvm/work/target-sdk-01 CARGO_INCREMENTAL=0 cargo check --workspace --all-targets
cargo machete
cargo metadata --locked > /dev/null
```

Verification output goes to files and exit codes are checked; the private target dir
is deleted once the gate passes.

## 9. PR bodies

Both: `Refs #4680`, the provisional list from section 4, the Cargo.lock churn note,
the "what stays byte-identical" statement, the sketch correction (ascending-only
indexes). Part 2 completes the task: `Dash-Tasks: SDK-01` on its own line. Titles:

1. `feat: add the dash-sdk-contract declaration model, grammar and diagnostics`
2. `feat: add dash-contract-build native schema translation and host validation`

No scope: the allowed scope list has `sdk` (JavaScript) and `rs-sdk` (application
SDK); a new contract-author crate fits neither, and `requireScope` is off.
