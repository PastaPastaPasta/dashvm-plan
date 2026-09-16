# FIX-07: bounded issuer-wide destruction and vestige custody

Working artifact. Never staged, never committed. Base `v5.0-dev` at `5f1e0ccdce` (protocol
14 is the last version on this branch; no DashVM lane has merged yet). Tier: xhigh confirmed
(consensus rules, storage layout, conservation, proofs, fee pins).

## 1. Acceptance in my words

1. Every token issuer (a data contract that owns tokens) has a per-issuer supply rollup that
   every native supply mutation keeps current in the same GroveDB batch. It is derived
   accounting, backfilled at the upgrade to the 5.0 protocol version, created at genesis for
   fresh networks and at contract creation for new issuers.
2. Destroying an issuer is one bounded write set: mark the issuer destroyed, move its rollup
   into an excluded ledger. No holder is visited, no token of the issuer is visited.
3. Raw totals stay untouched by destruction. Active totals are raw minus excluded. The block
   end token conservation check reads the excluded ledger and checks raw and active with
   checked arithmetic.
4. After destruction every native path of that issuer's tokens is closed: mint, burn,
   transfer, freeze, unfreeze, destroy frozen funds, emergency action, config update, claim,
   direct purchase, set price, and document actions paid with the token; contract updates
   cannot add tokens to a destroyed issuer.
5. Current-state balance, supply and status proofs and their queries report a destroyed
   issuer's tokens as non-existent, and the proof binds the issuer state, so a proof of an
   old raw leaf alone is never evidence of live tokens.
6. Physical removal of the issuer's holder leaves, infos, statuses, prices and distributions
   runs in bounded per-block steps with a durable cursor. Each step lowers the raw and
   excluded totals by the same amount, so active totals and the conservation equation never
   move. Canonical contract code and the token-to-contract link are never removed.
7. Foreign tokens (issued by other contracts) held by the wiped contract survive: cleanup
   only walks the issuer's own token ledgers, and the destroyed issuer record is the custody
   marker for the contract's storage principal. Exact recovery needs the contract token
   holder branch, which does not exist on this base (see section 8).

Q25 and Q27 are confirmed policy and are honoured as stated: immediate logical destruction
with validated aggregate accounting, bounded physical cleanup, destroyed tokens unusable on
every path, foreign tokens preserved, code permanent, recovery only through a separate
network vote that binds exact token ids, amounts and recipient (the vote itself is R11-10).

## 2. What the tree looks like today (drift notes)

- `LATEST_VERSION` is 14 on `v5.0-dev`. Four open lanes (`dashvm/r04-01` PR 4716,
  `dashvm/r06-05` PR 4717, `dashvm/r06-01` PR 4705, `dashvm/r08-01` PR 4712) each add
  `v15.rs`/`v16.rs` placeholders and a `v17.rs`; none is merged. Their placeholder files are
  byte-identical to each other, so a forward merge takes either side.
- Token ledger: `[Tokens 16] / 128 (BigSumTree) / token_id (SumTree) / identity (SumItem)`;
  supply `[Misc 104] / "T" (BigSumTree) / token_id (SumItem)`; status `[Tokens] / 64 /
  token_id (Item TokenStatus V0 {paused})`; contract info `[Tokens] / 160 / token_id (Item
  TokenContractInfo V0)`; identity infos `[Tokens] / 192 / token_id / identity`; price
  `[Tokens] / 92 / token_id`; distributions under `[Tokens] / 32`. Keys used under `[Tokens]`:
  32, 64, 92, 128, 160, 192.
- Every token has a contract info entry: the tree exists since the version 9 upgrade
  (`transition_to_version_9`) and both `insert_contract` v1 and `create_token_trees` v0 write
  it.
- Supply leaf writers: `add_to_token_total_supply` v0 (mint, mint_many, claim, direct
  purchase), `remove_from_token_total_supply` v0 (burn, destroy frozen funds),
  `insert_contract` v1 (base supply, inline), `create_token_trees` v0 (zero init, also used
  by `update_contract` v1 for tokens added on update). No other writer exists
  (`grep total_tokens_root_supply_path`).
- Conservation: `calculate_total_tokens_balance` v0 compares the two BigSumTree aggregates;
  `validate_token_aggregated_balance` v0 runs it at block end when
  `verify_token_sum_trees` is on (default true) from
  `process_block_fees_and_validate_sum_trees` v1.
- Validation: every one of the 11 token action validators calls
  `TokenBaseTransitionAction::validate_state` (slot `token_base_transition_state_validation`
  = 1 at protocol 14). Every document validator calls
  `DocumentBaseTransitionAction::validate_state` (slot 0), which is where document token
  payments are checked.
- GroveDB pin `6fc7e1e` has `Element::NotSummed`, propagation preserves it, but there is no
  operation that re-wraps an existing populated subtree in place: a batch `InsertOrReplace`
  of a tree element opens a fresh empty merk for that path (`TreeCache::insert` calls the
  merk opener with `new_merk = true`), and the non-batch insert rejects any tree element
  carrying a root key. The `NotSummed` wipe technique from the DIP therefore needs an
  upstream GroveDB primitive. This plan does not use it (section 3 explains the alternative).
- Contract token holdings (the holder branch under each token ledger) do not exist on this
  base. They are R04-01 part 4, not started.
- The Docker socket is not reachable for this user, so `dapi-grpc` clients cannot be
  regenerated locally. This plan changes no proto.

## 3. Design

### 3.1 Storage (provisional keys, PR body)

```
[Tokens 16]
  └ 224  TOKEN_ISSUERS_KEY                      NormalTree (new)
       ├ [0]  TOKEN_DESTROYED_SUPPLY_KEY         Item: u128 big-endian, 16 bytes
       │      total supply of all destroyed issuers not yet physically removed ("X")
       ├ [1]  TOKEN_ISSUER_CLEANUP_QUEUE_KEY     NormalTree (part 4)
       │      └ height_be(8) ‖ contract_id(32)  Item: TokenIssuerCleanupCursor (DPP, versioned)
       └ contract_id (32 bytes)                  Item: TokenIssuer (DPP, versioned)
```

`TokenIssuer::V0 { supply: u128, destruction: Option<TokenIssuerDestruction> }`,
`TokenIssuerDestruction::V0 { block_height: u64, block_time_ms: u64 }`. The one and two byte
keys cannot collide with a 32-byte contract id. Adding a seventh key under `[Tokens]` moves
the fee of some token writes at protocol 17 only (section 6).

Why one rollup and not two: the per-token invariant `supply == sum of balances` is enforced
every block, and every path that changes one changes the other by the same amount in the
same batch. A second per-issuer counter would be written with the same delta on every path.
The record therefore carries one number that is both the issuer's supply rollup and its
balance rollup; the block end check keeps the two-sided raw equality. This is a provisional
simplification of the proposed two-ledger layout in the findings resolution; it keeps raw,
excluded and active checks and adds nothing that can drift.

Why a scalar excluded ledger and not a sum tree: an issuer's rollup can exceed `i64` (two
tokens at `i64::MAX` base supply are legal today), so a `SumItem` cannot hold it, and a
`BigSumTree` child with an asserted sum and no children is a hack. A 16-byte item under the
same subtree is read once by conservation, written once by destruction and once per cleanup
step, and follows the `[Misc] / "D"` total credits precedent.

### 3.2 Rollup maintenance

- `add_to_token_total_supply` v1 and `remove_from_token_total_supply` v1 (copies of v0):
  after computing the actual delta, read `[Tokens]/160/token_id` for the contract id
  (absent: `CorruptedDriveState`), read the issuer record (absent: `CorruptedDriveState`),
  refuse when `destruction.is_some()` (`CorruptedDriveState`, a validator missed the check),
  write the record with `supply ± delta` (u128 checked). The saturated `added_amount` is the
  delta on the add side. Estimation adds the contract info and issuer layers.
- `create_token_trees` v1: also inserts the issuer record with supply 0 if it does not exist
  (update path adding a token to an existing issuer keeps the record).
- `insert_contract` v2 (copy of v1): inserts the issuer record once with supply equal to the
  sum of the contract's base supplies (u128 checked).
- Transfers change no rollup and read no issuer record at the Drive level.

### 3.3 Logical destruction

`Drive::destroy_token_issuer(contract_id, block_info, apply, transaction, platform_version)`
with the `_operations` and `_add_to_operations` triad: read record (absent → error, already
destroyed → `DriveError::TokenIssuerAlreadyDestroyed`), write record with
`destruction = Some(..)`, read X, write `X + supply` (checked), insert the cleanup queue entry
(part 4). Two reads, three writes, whatever the issuer's size. The caller is the lifecycle
task that applies an approved wipe (R11-10); no state transition triggers it here.

### 3.4 Conservation

`calculate_total_tokens_balance` v1 reads the two BigSumTree aggregates and X.
`TotalTokensBalance` gains `total_destroyed_supply: SumTokenAmount` (v0 backfills 0) and
`ok()` requires: raw supply ≥ 0, raw balances ≥ 0, raw supply == raw balances, X ≥ 0,
X ≤ raw supply. `Display` prints the active supply (raw minus X).

### 3.5 Path enforcement (part 2)

- New consensus error `TokenIssuerDestroyedError { token_id, contract_id }` in
  `errors/consensus/state/token/`, appended to `StateError`, code 40722 (next free in the
  40700 token band).
- `TokenBaseTransitionAction::validate_state` v2 = v1 plus one read of the issuer record for
  `data_contract_id()` (cost added as `PrecalculatedOperation`); destroyed → the error.
  Covers all 11 token transitions.
- `DocumentBaseTransitionAction::validate_state` v1 = v0 plus the same read for the paying
  token's contract (`DocumentActionTokenCost.contract_id.unwrap_or(own contract)`) when a
  token cost is present. Covers create, replace, delete, index-only delete, transfer, purchase
  and update price.
- `DataContractUpdate` state v2 = v1 plus: if the update adds tokens and the issuer record is
  destroyed, reject with the same error (bump nonce like the other state errors).
- Slots in `DRIVE_ABCI_VALIDATION_VERSIONS_V11` (copy of V10):
  `token_base_transition_state_validation: 2`,
  `document_base_transition_state_validation: 1`,
  `data_contract_update_state_transition.state: 2`.

### 3.6 Proofs and queries (part 3)

Value-bearing token proofs bind the issuer state. The prover reads the token's contract info,
builds one merged path query of the original query plus `[Tokens]/160/{token_ids}` and
`[Tokens]/224/{contract_ids}`, and proves it. The verifier cannot know the contract id in
advance, so it verifies in two subset passes against the same proof: first the contract
info keys, then the merged issuer-plus-value query; both root hashes must match
(`verify_chained_documents_proof` v0 already uses this two-pass shape). Interpretation: a
destroyed issuer's token is reported as absent (balance `None`, status `None`, supply
`WrongElementCount`/absent), a present value leaf without a contract info leaf is a proof
error. Return types do not change, so `drive-proof-verifier`, `rs-sdk`, `wasm-drive-verify`,
`wasm-sdk` and the FFI need no code change; they pick v1 through the platform version.

Methods bumped to v1 (5.0 tables only): prove `identity_token_balances`,
`identities_token_balances`, `total_supply_and_aggregated_identity_balances`,
`token_statuses`; verify `verify_token_balance_for_identity_id`,
`verify_token_balances_for_identity_id`, `verify_token_balances_for_identity_ids`,
`verify_token_total_supply_and_aggregated_identity_balance`, `verify_token_statuses`,
`verify_token_status`. New: `fetch_token_issuer`, `fetch_token_lifecycles(token_ids)` (Optional
slot, `None` on shipped tables returns every token as live), `prove_token_issuer`,
`verify_token_issuer`.

The four non-proof query handlers (`identity_token_balances`, `identities_token_balances`,
`token_total_supply`, `token_statuses`) call `fetch_token_lifecycles` after their raw fetch
and mask destroyed tokens the same way. The handlers are `v0` request-version modules and
non-consensus; the masking is gated by the Optional slot, so a node serving protocol 14 state
behaves exactly as today. Metadata proofs (identity token infos, prices, distributions,
contract info) stay raw; their mutation paths are closed by part 2 and their lifecycle is
available from `fetch_token_issuer` / `verify_token_issuer` for the proto surface that
50-PROOFS owns (A23). No proto, no SDK type, no wasm binding changes.

### 3.7 Bounded cleanup (part 4)

- Queue entry key `height_be ‖ contract_id`, value `TokenIssuerCleanupCursor::V0 {
  next_token_position: u16, phase: CleanupPhase, next_key: Option<Vec<u8>> }` with phases
  Balances, Supply, IdentityInfos, Status, Price, PerpetualDistribution,
  PreProgrammedDistribution, Done.
- New block end event `clean_up_destroyed_token_issuers` (Optional slot in
  `DriveAbciBlockEndMethodVersions`, `None` before 17), called in `run_block_proposal` v0
  right after `clean_up_expired_locks_of_withdrawal_amounts` and before
  `process_block_fees_and_validate_sum_trees`, following the `prune_shielded_pool_anchors`
  pattern. It takes queue entries in key order (FIFO by height) and spends a per-block leaf
  budget `SystemLimits::max_destroyed_token_issuer_cleanup_leaves_per_block` (Option<u16>,
  `None` on V1..V4, provisional 256 on the 5.0 table).
- Per step (one batch, atomic with the block): fetch the contract (its token positions are
  the enumeration, bounded by `u16`), then for the token at the cursor: page up to the
  remaining budget of holder leaves from `[Tokens]/128/token_id` (raw path query with limit,
  sum their values Δ, delete them), replace the supply leaf with `supply − Δ`, the issuer
  record with `supply − Δ`, X with `X − Δ`. Raw supply and raw balances move together, X
  moves with them, active totals do not move. When the ledger is empty: delete the ledger
  tree and the zero supply leaf; page identity infos and delete their tree; delete status
  and price; delete the perpetual info and page its last-claim entries; delete
  pre-programmed entries (times come from the contract configuration) and the timed queue
  references for those times; advance to the next token; when every token is done delete
  the queue entry. The contract info leaf and the issuer record stay forever (token id to
  issuer link and destroyed marker), which is what makes an id unusable for ever.
- Crash safety: the step is inside the block transaction; a rejected proposal rolls the
  whole step back; the cursor is written in the same batch as its effects.

### 3.8 Vestige custody (what this task can and cannot do)

Contract token holdings are the holder branch `[Tokens]/128/token_id/[0]/contract_id/…`
planned in R04-01 part 4 and absent on this base. Custody semantics this task fixes now:
the destroyed issuer record is the custody marker for the contract's storage principal (a
holding whose principal's issuer record is destroyed is spendable only through an approved
recovery), and cleanup never touches another token's ledger, so foreign holdings survive by
construction. The recovery application (exact token id, amount, recipient, consumed
authorization marker, native transfer validation) is a follow-on slice to open when the
holder branch merges; it cannot be built or tested against a ledger that does not exist.
Likewise the contract credit wipe write (move live total to the processing pool, exclude the
subtree) belongs to the lifecycle wipe integration once R04-01 part 2 (bucket storage) has
landed; the missing GroveDB re-wrap primitive noted in section 2 means that write will most
likely use an excluded scalar like 3.1 rather than `NotSummed`.

## 4. Parts

### Part 1: `feat(drive)!: keep per-issuer token supply rollups and a destroyed-issuer ledger`

Crates: `rs-dpp`, `rs-drive`, `rs-drive-abci`, `rs-platform-version`.

- `rs-dpp`: `src/tokens/issuer/{mod.rs, v0/mod.rs, methods.rs}` with `TokenIssuer`,
  `TokenIssuerDestruction` (derive stack as `TokenStatus`, `$formatVersion` serde tag),
  `TokenIssuerLifecycle { Live, Destroyed { block_height } }` (plain enum);
  `balances/total_tokens_balance` new field and checks;
  `DPPTokenVersions.token_issuer_default_structure_version` (new field, 0 on V1 and V2).
- `rs-drive`: `drive/tokens/paths.rs` constants and path helpers (verify-available);
  `drive/tokens/issuer/{fetch_token_issuer, fetch_token_lifecycles, add_to_token_issuer_supply,
  destroy_token_issuer, estimated_costs}` each `mod.rs` + `v0/`; `queries.rs` for the issuer
  and lifecycle queries (shared with part 3 verifiers); `tokens/system/add_to_token_total_supply/v1`,
  `remove_from_token_total_supply/v1`, `create_token_trees/v1`; `contract/insert/insert_contract/v2`;
  `tokens/calculate_total_tokens_balance/v1`; `initialization/v5` (or v4 if R04-01 is not
  merged when this lands: whichever is the next free generation, adding `[Tokens]/224` and its
  scalar to a new `initial_state_structure_lower_layers_add_operations_3`); `KnownPath::TokenIssuersRoot`
  in the batch debug printer; `DriveError::TokenIssuerAlreadyDestroyed` appended.
- `rs-drive-abci`: `transition_to_version_17_token_issuers` in the protocol change hook
  (idempotent: insert-if-not-exists of the subtree, the zero scalar and the queue tree, then a
  full read of `[Misc]/"T"` with a range-full raw query, contract info per token, one issuer
  record per contract with the summed supply; bounded by the number of tokens existing at the
  upgrade block, once).
- `rs-platform-version`: `v15/v16/v17` scaffold only if the base still ends at 14 (files
  identical to the open lanes); `DRIVE_TOKEN_METHOD_VERSIONS_V2` (V1 gains `issuer: {all None}`),
  `DRIVE_CONTRACT_METHOD_VERSIONS_V4` (`insert_contract: 2`), the 5.0 drive table (amend
  `DRIVE_VERSION_V10` if R04-01 merged first, else create it) selecting token V2, contract V4,
  `calculate_total_tokens_balance: 1`, initialization bump; `DriveTokenIssuerMethodVersions`
  group with `OptionalFeatureVersion` slots.
- Tests (with the implementation): rollup equals the sum of supplies after base supply, mint,
  mint_many, claim, burn; transfer leaves it untouched; `destroy_token_issuer` once-only, X
  after destruction, conservation `ok()` before and after, `VersionNotActive` at protocol 14
  for every issuer method; genesis-17 versus genesis-16-plus-upgrade element equivalence of
  `[Tokens]/224` with populated tokens (collect_subtree_diffs style); `deterministic_root_hash`
  re-pinned for 17; token and identity fee pins that move at 17 re-pinned with the 14 value
  kept where a per-version runner exists (the new key under `[Tokens]` and the extra issuer
  write per mint and burn).

Estimated diff: about 1 900 lines. `!` because a new state key and a new conservation term
change every node's state at protocol 17.

### Part 2: `feat(drive-abci)!: reject every token path of a destroyed issuer`

- `rs-dpp`: `TokenIssuerDestroyedError` file, `StateError` variant appended, `From`, code
  40722. `wasm-dpp2/src/consensus_error.rs` mirrors codes only where JavaScript branches on
  them; nothing branches on token state codes today, so no mirror.
- `rs-drive-abci`: token base `state_v2`, document base `state_v1`, contract update `state/v2`,
  `DRIVE_ABCI_VALIDATION_VERSIONS_V11` (full literal copy of V10 with three bumps) selected by
  the 5.0 platform version.
- Tests through `process_raw_state_transitions` in `batch/tests/token/destroyed_issuer/`:
  after `destroy_token_issuer` inside a committed transaction, each of the 11 token transitions
  and a document create paid in the token returns the error and is paid; a contract update
  adding a token to the destroyed issuer is rejected; a transfer of a token from a different,
  live issuer in the same block succeeds; the same transitions at protocol 16 with no issuer
  record succeed (the slot is 1 there and no issuer read happens). Fee pins: the extra issuer
  read moves the processing fee of every token transition at 17; re-pin.

Estimated diff: about 900 lines.

### Part 3: `feat(drive): bind token balance, supply and status proofs and queries to issuer destruction`

- `rs-drive`: prove v1 modules (four), `verify/tokens/*/v1` (six) plus
  `verify/tokens/verify_token_issuer/v0`, `prove_token_issuer/v0`, query builders,
  `DRIVE_VERIFY_METHOD_VERSIONS_V3` (V2 plus the six bumps and the issuer slot at 0) in the 5.0
  drive table. All verify code compiles under `--no-default-features --features verify`
  (path helpers in `tokens/paths.rs`, DPP types, no server helpers).
- `rs-drive-abci`: the four query handlers mask through `fetch_token_lifecycles`.
- Tests: prover-verifier round trips live and destroyed for each method (destroyed reports
  absent), a proof missing the issuer branch fails verification at 17, a v0 proof still
  verifies at 16, handler tests for masked responses, `cargo check -p drive
  --no-default-features --features verify`. `rs-sdk` recorded vectors replay at their recorded
  version and are untouched.

Estimated diff: about 1 400 lines. No `!`: proof shape and verifier selection follow the
platform version and are not block validity.

### Part 4: `feat(platform)!: clean up destroyed token issuers in bounded per-block steps`

- `rs-dpp`: `TokenIssuerCleanupCursor` (versioned), `CleanupPhase`.
- `rs-platform-version`: `SystemLimits::max_destroyed_token_issuer_cleanup_leaves_per_block`
  (`None` on V1..V4 and both mocks, `Some(256)` on the 5.0 table; amend an existing V5 in
  place), `DriveAbciBlockEndMethodVersions::clean_up_destroyed_token_issuers:
  OptionalFeatureVersion` (`None` on V1..V10 and mocks, `Some(0)` on the 5.0 table),
  `DriveTokenIssuerMethodVersions::clean_up_destroyed_token_issuer_step`.
- `rs-drive`: `tokens/issuer/clean_up_destroyed_token_issuer_step/v0` returning the leaves
  spent and the new cursor, queue helpers, `destroy_token_issuer` inserts the queue entry.
- `rs-drive-abci`: `platform_events/tokens/clean_up_destroyed_token_issuers/v0` and the gated
  call in `run_block_proposal` v0.
- Tests: a destroyed issuer with two tokens, many holders, frozen infos, a price, a perpetual
  and a pre-programmed distribution is cleaned over several blocks with a small budget;
  after every block raw supply equals raw balances, X drops by the same amount as the leaves,
  the active total is constant, conservation holds; restart mid-cleanup (drop the platform,
  reopen from the committed state, continue) reaches the same final root as an uninterrupted
  run; contract element and contract info leaves are unchanged; a foreign token ledger with
  the wiped contract's owner identity as holder is untouched; budget of zero performs no
  work; two queued issuers are processed FIFO. Strategy test not required (multi-block
  behaviour is exercised with `TestPlatformBuilder` blocks; add a strategy case only if the
  per-block hook needs proposer churn coverage).

Estimated diff: about 1 300 lines. `!` because block processing gains a state-changing step.

Total about 5 500 lines across four PRs. Each part compiles and passes CI alone; part 1
depends on nothing later; parts 2 to 4 stack on the previous one until it merges.

## 5. What stays byte-identical

Every shipped `vN` module (token operations v0, `insert_contract` v1, `create_token_trees`
v0, `calculate_total_tokens_balance` v0, all validators' v0/v1, all verify v0, genesis v0 to
v3 or v4), every shipped version table except struct-literal backfills (`issuer: { None.. }`,
`max_destroyed_token_issuer_cleanup_leaves_per_block: None`,
`clean_up_destroyed_token_issuers: None`, `token_issuer_default_structure_version: 0`,
`total_destroyed_supply: 0`), the proto files, generated clients, SDK and wasm surfaces,
`TokenStatus`, `TokenContractInfo`, error codes below 40722, and all fee pins at protocol 14.

## 6. Versioning consequences (full list)

- Protocol versions 15, 16 (placeholders) and 17 (5.0), scaffolded only if absent at rebase.
- Drive table for 5.0: initialization bump, `calculate_total_tokens_balance: 1`, token V2,
  contract V4, verify V3 (part 3).
- `DRIVE_ABCI_VALIDATION_VERSIONS_V11` (part 2); the 5.0 drive-abci method table gains the
  block end slot (part 4; amend `DRIVE_ABCI_METHOD_VERSIONS_V11` if r06-05 merged first).
- `SystemLimits` new Option field (part 4), backfilled `None`.
- `DPPTokenVersions.token_issuer_default_structure_version` (part 1).
- Consensus error 40722 (part 2).
- Fee pins at 17 move for token writes under the new key's AVL neighbourhood and for every
  token transition (issuer read) and mint/burn (issuer write); 14 pins unchanged.
- No fee schedule, no proto, no SDK signature changes.

## 7. Local gate (each part)

```
cargo fmt --all -- --check
cargo clippy -p dpp -p drive -p drive-abci -p platform-version --all-features --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo check -p drive --no-default-features --features verify        # parts 1 and 3
cargo test -p platform-version --all-features
cargo test -p dpp --all-features --lib -- tokens::issuer total_tokens_balance
cargo test -p drive --all-features --lib -- tokens::issuer tokens::system tokens::calculate_total_tokens_balance contract::insert initialization verify::tokens
cargo test -p drive --all-features --test deterministic_root_hash
cargo test -p drive-abci --all-features --lib -- perform_events_on_first_block_of_protocol_change batch::tests::token query::token_queries tokens::clean_up
```

Redirect each to a file, check the exit code, never end in a pipe.

## 8. Provisional values and interpretations (PR bodies)

1. `TOKEN_ISSUERS_KEY = 224` under `[Tokens]`, scalar key `[0]`, queue key `[1]`; unallocated
   in the register (A09), free in the tree, revised before any network proposes 17.
2. Protocol 17 as the 5.0 version, 15 and 16 as placeholders; table generation numbers are
   "next free" and are renumbered or amended at rebase against whichever lane merges first.
3. One per-issuer rollup that is both supply and balance rollup (section 3.1).
4. Excluded ledger as a u128 scalar plus per-issuer records, not a sum tree (section 3.1).
5. Consensus error code 40722; error name `TokenIssuerDestroyedError`.
6. Destroyed tokens are reported as absent by balance, supply and status queries and proofs;
   the reason is exposed through the issuer fetch and proof for the proto surface owned by
   50-PROOFS.
7. Metadata proofs (infos, prices, distributions, contract info) stay raw.
8. Cleanup budget 256 leaves per block, FIFO by destruction height, cursor phases as listed.
9. The contract info leaf and the issuer record are permanent tombstones.
10. Vestige recovery transfer and the contract credit wipe write are follow-on slices gated on
    R04-01 parts 4 and 2 (section 3.8); the governance trigger is R11-10.
11. Contract updates that add tokens to a destroyed issuer are rejected (part 2) even though
    the wiped-contract lifecycle state itself belongs to the lifecycle tasks.
