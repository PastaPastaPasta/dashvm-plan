# FIX-05 plan: portable logical stack, native stack headroom, deterministic growth and versioned costs

Working artifact. Never staged or committed. Delete when the task ships.

Base: `v5.0-dev` at `5f1e0ccdce` (worktree branch `dashvm/fix-05`). Tier: xhigh (VM boundary, protocol-metered costs, protocol table amendment). Three sequential parts, all on `v5.0-dev`. Planned 2026-09-15.

**Status: blocked on R08-01.** Section 2 has the evidence. Everything below is written against the shapes R08-01 has landed (Part 1, PR #4712) and planned (Parts 2 and 3, `~/dashvm/runs/R08-01/PLAN.md`); section 9 is the checklist the implementer runs against the real tree once R08-01 is merged.

## 1. Acceptance restated

FIX-05 is the hardening refinement of the engine layer R08-01 builds. It is done when, on the pinned Wasmtime 36.0.14 / Cranelift profile that R08-01 ships:

1. **Portable frame and operand accounting is complete.** Every guest activation, whatever route reaches it (direct call, `call_indirect`, export, cross-module binding, nested contract frame), is charged the callee's frame cost (base plus typed parameters, typed locals and operand slots) and one activation against one pair of counters shared by the whole outer invocation. No admitted operator can consume guest stack without being counted. This is R08-01 Part 1's instrumentation; FIX-05 verifies completeness, fixes any gap found, and owns the numbers (allocation register entry A06).
2. **Native stack headroom is independently demonstrated.** For each supported target (x86_64 Linux, aarch64 Linux and macOS) the native stack a guest can consume at the logical limit is measured with an adversarial corpus, a headroom ratio with margin is pinned in the engine profile, the runtime refuses to construct an engine whose `max_wasm_stack` and invocation thread stack do not satisfy the derived invariant, and `Trap::StackOverflow` is classified as a node fault that the corpus proves unreachable at the shipped limits. Architecture-specific native exhaustion cannot precede the logical trap.
3. **Memory growth is deterministic and reserved.** `memory.grow` outcomes depend only on protocol limits (per-instance pages, per-invocation aggregate pages, computation budget), never on host memory pressure. A host allocation failure inside the admitted reservation is a node fault, never a `-1` the guest can observe. Growth, bulk copies and fills are metered per page and per byte with checked arithmetic, and the charge lands in the same counter that bounds the invocation so no guest can exceed its admitted computation bound through them.
4. **Costs are versioned.** Every weight the runtime charges (host entry, copied byte, initialised byte, growth page, instance base, and the new table element weight) lives in `DashVmMeteringWeights` under `PlatformVersion::dashvm`, selected by the metering generation. Generation 0 is Wasmtime fuel plus these weights; its operator schedule is stated exactly and its trap-time accounting is shown deterministic.
5. **Scalar floats with NaN canonicalization are proven deterministic across architectures.** A shared corpus of NaN, signed-zero, subnormal, conversion, integer-trap, memory-trap, table-trap, fuel-exhaustion, stack-exhaustion, growth and bulk-copy cases has pinned expected results: outcome kind, trap code, result bits and protocol-metered computation consumed. The same pinned vectors are checked on x86_64 and aarch64. Raw Wasmtime fuel is consensus-visible in generation 0 (the protocol cost is derived from it), so it is part of the pinned cost; it is also recorded separately as a diagnostic. A mismatch on either architecture fails CI, which is the "consensus-visible mismatch rejects the profile" rule made mechanical.
6. **The complete engine profile is recorded.** Release pin, feature set, Cranelift settings, per-target CPU feature policy (baseline ISA, no host inference), memory reservation and guard layout, trap mechanism, preparation and metering generations, `max_wasm_stack`, thread stack and headroom constants are all emitted as one canonical record that the corpus artifact carries next to every result.

Exact limits and weights remain provisional benchmark inputs (Q40). SIMD and relaxed SIMD stay disabled (Q04). Nothing here activates contracts, adds a state transition, touches fees in credits or storage, or changes any shipped protocol version.

Out of scope, owned elsewhere: the complete weighted opcode schedule (R03-07, metering generation 1), the admitted feature allowlist beyond the two operators this plan rejects (R03-04, A05), the engine pin itself and cache (R08-01, A04), fee prices in credits (R12-03, A15), consensus error codes for exhaustion (R12-07), historical replay tooling (R03-01, R03-02, R11-09), the ABCI-level determinism artifact's engine slot (filled when ABCI executes contracts, R08-05/R10-01).

## 2. Tree facts, drift and the dependency decision

Checked on 2026-09-15 against `origin/v5.0-dev` (`5f1e0ccdce`, unchanged since 2026-09-12) and the sibling branches.

| Item | Observed |
| --- | --- |
| `packages/rs-dashvm-validation`, `packages/rs-dashvm` | Neither exists on `v5.0-dev`. The validation crate exists only on `origin/dashvm/r08-01` (PR #4712, open, 6 commits, head `3e30f508e0`, CI green except the base-branch-wide `policy / reconcile` break). The runtime crate does not exist anywhere: R08-01 Parts 2 and 3 are `pending` in `~/dashvm/state.json`. |
| `PlatformVersion::dashvm`, `DashVmVersion`, `DashVmLimits`, `DashVmMeteringWeights`, `DASHVM_VERSION_V1`, `v15.rs`, `v16.rs`, `v17.rs`, `LATEST_VERSION = 17` | All on PR #4712 only. `v5.0-dev` still has `LATEST_VERSION = 14` and no `dashvm` field. |
| Logical-stack instrumentation (`instrumentation/{frame_cost,rewrite,thunks}.rs`, `stack.rs`, `abi_names.rs`) | On PR #4712. Frame cost = 32 + 4 or 8 per typed parameter and local + 8 per operand slot (upper bound, the validator reports height only). Two down-counting host globals `dash_vm.stack_bytes`, `dash_vm.stack_depth`, one `dash_vm.trap(i32)` import, `enter`/`leave` helpers of type `(i32) -> ()`, thunks for every table- or export-reachable function, exports and element segments redirected to thunks. Trap codes 1 (bytes) and 2 (depth). Golden fixture `tests/fixtures/three_functions.prepared.wasm`. |
| Bulk memory operators | Admitted on memory 0 (`wasm_features.rs`). `memory.copy`, `memory.fill`, `memory.init`, `table.copy`, `table.fill`, `table.init`, `table.grow` and `memory.grow` pass through untouched; passive data segments are measured (`passive_data_bytes`) and admitted. |
| Wasmtime 36.0.14 fuel schedule (`wasmtime-internal-cranelift-36.0.14/src/func_environ.rs:354-465`) | 1 unit per operator except `nop`, `drop`, `block`, `loop`, `unreachable`, `return`, `else`, `end` at 0. Consumption is buffered in a local and flushed to the store only at `loop`, `if`, `br`, `br_if`, `br_table`, `end`, `else`, calls and returns; the fuel check itself runs at function entry and loop headers. A trap mid-block therefore reports the last flushed value. This is decided at wasm-to-CLIF translation, before any ISA lowering, so it is target-independent, but it is block-granular: `memory.fill` of 128 MiB costs 1 unit; a division by zero ten operators into a block reports the fuel at the block's start. |
| `ResourceLimiter` (`wasmtime-36.0.14/src/runtime/limits.rs:32-135`) | `memory_growing(current, desired, maximum) -> Result<bool>`: `Ok(false)` makes `memory.grow` return `-1`; `Err` traps. `memory_grow_failed(error)` is called when the OS refuses after approval. The limiter is a field of the store data and has no access to fuel: growth cannot be charged from inside it, and a charge that cannot trap cannot bound the invocation. |
| `Config::max_wasm_stack` (`config.rs:678-718`, `runtime/func.rs:1560-1625`) | A per-store-entry cap computed as `sp - max_wasm_stack` at the first entry; a nested store (fresh `Runtime::invoke` from a host call) computes its own from the then-current `sp`. The knob limits wasm frames only; exhausting the thread stack aborts the process. Default 512 KiB. |
| `Config::target` (`config.rs:293-316`, `build_compiler` at 2373) | An explicit target disables host CPU feature inference: the baseline ISA of the architecture is what Cranelift compiles for unless `cranelift_flag_enable` is called. `preserve_frame_pointers`, `enable_probestack` (inline), `enable_multi_ret_implicit_sret` are forced on. |
| `wasm_call_conv` (`wasmtime-internal-cranelift-36.0.14/src/lib.rs:173-193`) | `CallConv::Tail` for wasm functions on every target when Winch is not selected. |
| `Config::cranelift_nan_canonicalization` (`config.rs:1306-1320`) | Off by default; canonicalizes f32, f64 and v128 results of float operations. |
| Runners | `tests-rs-workspace.yml` runs on `[self-hosted, rust-ci]`, whichever of the macOS (aarch64) and Linux (x86_64) boxes is free: one PR run lands on one architecture. R14-01 (PR #4718, open) adds `tests-rs-determinism.yml` on GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm` with a three-section artifact (`consensus` byte-identical, `profile` explained, `diagnostic` printed) and `compare-determinism-artifacts.py`; its `Profile.engine: Option<EnginePin>` and `Diagnostic.engine_fuel` slots are `None`. |
| R06-01 (PR #4705, open) | `SystemLimits.smart_contract_computation` (25,000,000 units per invocation, 250,000,000 per block), `ComputationUnits = u64`, `FeeVersion.dashvm`. Not read by this task; the runtime's budget parameter is R08-01's concern. |
| Issue line numbers | None cited for this task; no drift to record beyond the above. |

**Dependency decision.** FIX-05's two modules are `VALIDATE` (`rs-dashvm-validation`) and `METER` (`rs-dashvm`). Both are crates R08-01 creates; every file this plan edits is in them or in the DashVM protocol table R08-01 adds. The task record lists no prerequisite because the register marks FIX-05 a refinement of R03-01, R03-07, R08-02 and R08-08 ("not extra dependency edges"), but the tree makes R08-01 a hard prerequisite: there is nothing on `v5.0-dev` to instrument, meter or measure. Stacking FIX-05 on `dashvm/r08-01` would mix in two unstarted R08-01 parts, and delivering validation-side rewrites before the runtime exists would emit prepared modules importing host functions nothing defines. So: **blocked on R08-01 (all three parts)**. `deps_not_needed` is empty: no listed edge to waive.

One fact worth relaying to the R08-01 lane before its Part 2 lands (section 3.3): the `ResourceLimiter` cannot reach store fuel, so growth charged inside the limiter cannot trap on budget exhaustion and a guest could exceed its admitted computation bound by up to `max_memory_pages_per_invocation × memory_growth_page` (268 M units against a 25 M budget). The deterministic shape is host-mediated growth.

## 3. Design decisions

### 3.1 What stays as R08-01 built it

The frame formula (`FRAME_BASE_BYTES = 32`, typed 4/8 bytes per parameter and local, 8 bytes per operand slot as an upper bound), the two down-counting globals, the trap import and codes, `enter`/`leave` and the thunk design, the `IndexPlan` and provenance check, the limits `max_logical_stack_bytes = 1 MiB` and `max_activation_depth = 512`, and every other value in `DASHVM_VERSION_V1`. FIX-05 confirms them as the A06 allocation and does not re-derive them. The operand-slot upper bound stays: typed operand tracking would need `FuncValidator::get_operand_type` per operator (quadratic in operand depth) and overcharging is safe for a protocol bound.

Completeness argument for the accounting, to be restated in the crate docs: every defined function is reachable only by a direct `call` (wrapped at the site with the callee's cost), by the table (element segments redirected to thunks; `table.grow` and `table.set` are rejected, section 3.2, so no un-thunked reference can enter a table), by an export (redirected to a thunk, which is how the host and cross-module bindings enter), or by `ref.func` (rewritten to the thunk). Calls to imported functions consume host stack, not guest stack, and are bounded by the host-call cap and the nested-frame cap. `return_call*` is rejected by the feature allowlist. There is no fifth route.

### 3.2 Preparation generation 0 amendments (unreleased, amended in place)

Preparation generation 0 is referenced only by `DASHVM_VERSION_V1` on protocol version 17, which no network has run, so it is amended in place under the conventions rule for unreleased tables; the golden fixture is regenerated once and the PR body says why. The instrumenter additionally:

- Prepends three function imports next to `dash_vm.trap`: `dash_vm.grow(delta: i32) -> i32`, `dash_vm.charge_bytes(len: i32)`, `dash_vm.charge_elements(count: i32)`. `INJECTED_FUNCTION_IMPORTS` becomes 4; submitted function indices shift by 4; the provenance check in `admission.rs` expects exactly these imports in exactly these positions.
- Replaces every `memory.grow` with `call $dash_vm.grow`. Same operand and result type, so the operand stack is unchanged.
- Pre-charges the length-carrying bulk operators. For `memory.copy`, `memory.fill`, `memory.init` (length on top of the stack): `local.tee $scratch; local.get $scratch; call $dash_vm.charge_bytes; <op>`. For `table.copy`, `table.fill`, `table.init`: the same with `charge_elements`. A function containing at least one such operator gets one extra `i32` local appended after its declared locals (index = params + declared locals; appending does not shift existing indices). The structure pass records `has_length_charged_ops` per function so the rewriter knows to add the local; the frame cost includes the extra local (4 bytes) when present, so the prepared frame cost is still a pure function of the canonical bytes.
- Rejects `table.grow` and `table.set` at admission with a new `ForbiddenFeature::TableMutation` (provisional, section 6). No table export is admitted, so a host function could not reach the table to grow it deterministically, and a guest-written table entry would bypass the thunk redirection. Rust 1.92 emits neither for `wasm32-unknown-unknown` without `-C link-arg=--growable-table`. `table.size`, `table.get`, `memory.size`, `data.drop`, `elem.drop` stay (constant cost, 1 fuel each).

Prepared byte growth per bulk site is bounded (three operators plus one local per function), so `max_prepared_module_bytes` still holds; the structure pass on the prepared stage measures it.

### 3.3 Host-mediated growth and copies (runtime)

Three host functions defined by the runtime's linker for every instance, in module `dash_vm`, next to the trap and the two globals. None is reachable from a submitted module (the `dash_vm` import rejection stands). None charges `host_entry`: they are instrumentation, not host work.

`dash_vm.grow(delta)`:

1. Read the caller's memory through the mandatory `memory` export. `current` pages from `Memory::size`.
2. `new = current.checked_add(delta)`; if `new > min(declared_maximum, max_memory_pages_per_instance)` return `-1`.
3. If `scope.pages_granted.checked_add(delta) > max_memory_pages_per_invocation` return `-1`. `pages_granted` starts at the sum of initial pages of every instantiated module in the closure and is the invocation's deterministic logical reservation.
4. `cost = delta × memory_growth_page` (checked); if `remaining_fuel < cost` trap `OutOfComputation` (fuel set to zero first so the consumed report equals the budget, as it does for operator exhaustion). Otherwise `set_fuel(remaining - cost)`.
5. Set the limiter's `approved_growth` marker, call `Memory::grow`, clear the marker. `Ok(old)` returns `old` pages and adds `delta` to `pages_granted`. `Err` means the OS refused inside the admitted reservation: set the node-fault flag, return a trap; the outcome classifier reports `DashVmError::NodeFault(AllocationFailed)`, never a guest result.

The `ResourceLimiter` becomes a backstop: `memory_growing` returns `Ok(true)` only while `approved_growth` is set, and `Err` (node fault, provenance breach) otherwise; instantiation's initial allocation is approved by the linker the same way after checking the aggregate. `table_growing` returns `Err` unconditionally (no admitted route grows a table). `memory_grow_failed` records the OS error into the node-fault flag. `instances`, `tables`, `memories` return `max_modules_per_bundle`, `max_modules_per_bundle`, `max_modules_per_bundle`.

`dash_vm.charge_bytes(len)`: `cost = len × copied_byte` (checked, `len` as `u32`), trap `OutOfComputation` if unaffordable, otherwise deduct. `dash_vm.charge_elements(count)`: `cost = count × table_element_copied` (new weight, provisional 8 units per element, the register's one unit per copied byte at pointer width). The bulk operator itself then runs as ordinary wasm with its spec-defined bounds trap, so a copy that is out of bounds is charged and then traps `MemoryOutOfBounds`, which is the "charge specified consumed work" rule for a paid failure.

Budget exhaustion on growth is an `OutOfComputation` trap, not `-1` (provisional interpretation): the page caps are resource limits and get the spec-defined failure value; the computation budget is a protocol-metered exhaustion and gets the same outcome as operator exhaustion everywhere else. Both are deterministic; the corpus pins both.

### 3.4 Native stack headroom (runtime, engine profile v0)

Constants in `dashvm::limits::native_stack` (provisional, section 6):

| Constant | Provisional value | Meaning |
| --- | --- | --- |
| `NATIVE_BYTES_PER_LOGICAL_BYTE` | 4 | Upper bound on native frame bytes per charged logical byte. Cranelift spills 32-bit values into 8-byte slots (ratio 2 for `i32`/`f32` locals and operands), a thunk holds a second copy of every parameter across its `enter` call (ratio up to 2 for parameter-heavy frames), plus return address, frame pointer and alignment against the 32-byte base. 4 leaves a factor of about 2 over the expected worst case; the measurement test asserts the actual ratio on this target is at most half of it. |
| `NATIVE_BYTES_PER_ACTIVATION` | 256 | Fixed native overhead per activation not proportional to logical bytes: the thunk's own frame, the trampoline for `call_indirect`, probestack slop. |
| `HOST_BYTES_PER_NESTING` | 512 KiB | Rust frames between a host call and the nested `Runtime::invoke` it opens (drive-contracts adapter, decoding, the new store), per nested contract frame. |
| `ENTRY_SLOP_BYTES` | 64 KiB | Wasmtime's own entry frames and the "few hundred bytes of slop" its stack-limit computation documents, rounded generously. |

Derived requirements, checked once at `Runtime` construction and failing with `DashVmError::ProfileRejected(String)` when violated (an engine that cannot prove headroom is not constructed):

```
guest_native_bound = NATIVE_BYTES_PER_LOGICAL_BYTE * max_logical_stack_bytes
                   + NATIVE_BYTES_PER_ACTIVATION * max_activation_depth
                   + ENTRY_SLOP_BYTES
max_wasm_stack     >= guest_native_bound                         // provisional profile value 8 MiB; bound is ~4.2 MiB
thread_stack       >= max_wasm_stack
                   + guest_native_bound                          // guest frames of the outer levels already on the stack
                   + (max_nested_contract_frames - 1) * HOST_BYTES_PER_NESTING
                   + ENTRY_SLOP_BYTES                            // provisional thread stack 32 MiB; bound is ~16 MiB
```

The logical stack is one shared counter across the call tree, so the guest frames of every nesting level together never exceed `guest_native_bound`; `max_wasm_stack` is a per-store cap window, not a reservation, which is why it appears once in the thread bound. `max_wasm_stack` rises from R08-01's planned 4 MiB to 8 MiB so the first inequality holds with margin; both remain local engine policy in profile v0's canonical record, not protocol table values. Every invocation runs on a dedicated scoped thread of `thread_stack` bytes (R08-01's design); R11-06 may pool threads without changing the bound.

`Trap::StackOverflow` stays a node fault in the outcome classifier (never a paid guest failure), and the corpus below proves it is not reached at the shipped limits.

Measurement, in `tests/native_stack.rs`, on whichever architecture runs the test: for each adversarial case, construct test engines whose `max_wasm_stack` is 512 KiB, 1 MiB, 2 MiB, 4 MiB and the profile value (the `NativeStackPolicy` is a constructor parameter; production passes the profile constant), run to logical exhaustion and find the smallest cap at which the outcome is `LogicalStackExhausted` rather than `StackOverflow`. That cap bounds the native bytes the case used; divide by the logical bytes charged at exhaustion to get the case's ratio. Assert every measured ratio is at most `NATIVE_BYTES_PER_LOGICAL_BYTE / 2` and every case completes at the profile value. Write the per-case measurements into the diagnostic artifact (section 3.6) so the two architectures' ratios sit side by side in CI output.

Adversarial stack corpus (`tests/corpus/stack/*.wat`), each pinned to its outcome (`LogicalStackExhausted` with trap code 1 or 2) and its computation consumed:

1. Leaf recursion with no locals: depth trips first (32 × 512 = 16 KiB of bytes).
2. 1,024 `i32` locals per frame (4 KiB logical): bytes trip at 255 frames.
3. 1,024 `i64` locals (8 KiB): bytes trip at 127 frames.
4. 128 `i64` parameters forwarded through recursion: parameter-heavy frames through the thunk path (`call_indirect`), the case expected to have the highest ratio.
5. 4,096 pushed operands live across the recursive call (32 KiB per frame): operand-heavy frames.
6. Mixed `f32`/`f64` locals kept live across the call so the register allocator must spill floats.
7. Recursion through `call_indirect` only (every activation pays the thunk overhead).
8. Two-module bundle where the entry module calls into module B and B recurses through its own export (cross-module bindings land on the thunk; exercise the shared counters across instances).
9. Nested contract frames: an outer invocation consumes about half the logical stack, then a host call opens a nested invocation that recurses to exhaustion; the nested outcome is `LogicalStackExhausted` and the outer is poisoned. Then eight nested frames each holding a small frame, exhaustion in the innermost, no `StackOverflow`.
10. Exactly at the limit: a chain whose last frame leaves zero bytes remaining completes (`Completed`), and the same chain with one more 4-byte local traps at the last call.

### 3.5 Trap and float corpus with pinned protocol-metered cost (`tests/trap_corpus.rs`)

Fixtures in `tests/corpus/{float,int,memory,table,fuel,growth,bulk}/*.wat`, expected vectors in `tests/corpus/vectors.json` (one object per case: name, entry, arguments, expected `outcome` ∈ {`completed`, `trap:<kind>`, `logical_stack:<code>`, `out_of_computation`}, expected `result_bits` as hex when completed, expected `computation_consumed`, and a `diagnostic_raw_fuel` field the test never asserts on). The vector file is one shared fixture, not a per-architecture file: the test on a Linux x86_64 runner and the test on a macOS or Linux aarch64 runner check the same numbers. Categories:

- NaN production and canonical bits: `0/0`, `inf - inf`, `sqrt(-1)`, `nan(payload) + 1` for f32 and f64, `f32.demote_f64` and `f64.promote_f32` of NaNs with payloads and sign, `copysign` with NaN, `min`/`max` with one and two NaN operands, `f32.reinterpret_i32` of a signalling NaN pattern passed through `f32.add 0`, `neg`/`abs` of NaN (bitwise, payload preserved: the expected bits are the input bits, which is deterministic and must stay so), the canonical results `0x7fc00000` and `0x7ff8000000000000`.
- Signed zero: `-0 + 0`, `0 × -1`, `min(-0, 0)`, `max(-0, 0)`, `sqrt(-0)`, `ceil(-0.5)`, `trunc(-0.5)`, `nearest(-0.5)`, `copysign(1, -0)`.
- Subnormals: `f32.mul` underflow to subnormal, `f64.div` producing subnormal, `f32.demote_f64` of a value below f32 normal range, subnormal `× 1`, `nearest`/`trunc`/`floor` of subnormals, `f32.sqrt` of a subnormal, subnormal `+ subnormal` carrying into normal.
- Conversions: `i32.trunc_f32_s` of NaN, `+inf`, `-inf`, `2^31`, `-2^31 - 1` (each `BadConversionToInteger`), `trunc_sat` variants of the same inputs (completed, pinned values), `f32.convert_i64_u` rounding at a tie, `f64.convert_i64_u` of `u64::MAX`, `i64.trunc_f64_u` of `2^64 - 1024`.
- Integer traps: `i32.div_s` by zero, `i32.div_s MIN / -1` (`IntegerOverflow`), `i64.rem_s MIN % -1` (completes with 0), `i32.rem_u` by zero, `i64.div_u` by zero.
- Memory: load at `memory.size × 65536 - 4` (completes), load at `- 3` (`MemoryOutOfBounds`), store past the end, unaligned `i64.load` (completes), load after a `grow` of one page at the new last byte (completes), the guard-page distance: a load at offset `2^32 - 1` with a zero base (`MemoryOutOfBounds`).
- Table: `call_indirect` to a null entry (`IndirectCallToNull`), with a mismatched signature (`BadSignature`), index past the table (`TableOutOfBounds`).
- `unreachable` (`UnreachableCodeReached`).
- Fuel: a counted loop whose budget is exhausted at iteration N (`OutOfComputation`, consumed equals the budget); the same loop with budget N × cost completes with consumed pinned; a straight-line body of 1,000 `i32.add` then a division by zero (pins the block-granular trap-time value, section 2's fuel finding).
- Growth: grow to the declared maximum (returns old size each time, consumed pinned), grow past the declared maximum (`-1`, no charge), past the per-instance cap when the declared maximum is larger (`-1`), a two-instance bundle growing past the per-invocation aggregate (`-1` on the second instance), grow with a budget smaller than `delta × memory_growth_page` (`OutOfComputation`, consumed equals budget), initial pages count toward the aggregate.
- Bulk: `memory.fill` of 1 MiB (consumed includes 1,048,576 × `copied_byte`), `memory.copy` overlapping forward and backward (result bytes pinned), `memory.copy` out of bounds (charged then `MemoryOutOfBounds`), `memory.init` from a passive segment, `table.copy` of 1,000 elements (8,000 units), `table.fill`, `memory.fill` of 128 MiB under the 25 M budget (`OutOfComputation`).
- Node fault injection: a test-only limiter wrapper that makes `Memory::grow` fail inside the admitted reservation; the outcome is `Err(DashVmError::NodeFault(..))`, never `-1`, never a guest trap. A test-only store whose `approved_growth` marker is never set drives a raw growth request through the limiter and observes the provenance node fault.

Per case the test asserts outcome, result bits and `computation_consumed` against the vector, and additionally that `computation_consumed == budget - store.get_fuel() - host_charges` reconciles. Raw fuel (`budget - get_fuel()` before host charges are added back) is recorded as `diagnostic_raw_fuel` in the artifact. In generation 0 the protocol cost is derived from fuel, so the pinned `computation_consumed` already makes raw trap fuel consensus-visible and checked; the diagnostic copy exists so a future weighted generation can keep recording it without comparing it, as the acceptance asks.

Every corpus case is a valid admitted module and runs through `validate_and_prepare_bundle` first, so the corpus also exercises the instrumented `memory.grow` and bulk pre-charge paths end to end. Cases are small (tens of operators) so the suite runs in well under a minute on both architectures.

### 3.6 Profile record and corpus artifact

`dashvm::engine::profile::v0::record() -> EngineProfileRecord { name: "wasmtime-cranelift", version: "36.0.14", settings: BTreeMap<String, String> }` with every consensus-relevant and headroom-relevant setting spelled out: `target` (explicit triple), `cpu_feature_policy` (`baseline-isa-no-host-inference`), the per-architecture baseline statement (x86_64: SSE2 only, `has_sse3`/`has_ssse3`/`has_sse41`/`has_sse42`/`has_popcnt`/`has_avx`/`has_bmi1`/`has_bmi2`/`has_lzcnt`/`has_fma` all false; aarch64: `has_lse`/`has_pauth` false, `sign_return_address` off), `opt_level`, `nan_canonicalization: true`, `consume_fuel: true`, `epoch_interruption: false`, every `wasm_*` feature toggle, `memory_reservation`, `memory_guard_size`, `memory_reservation_for_growth`, `guard_before_linear_memory`, `memory_may_move`, `signals_based_traps`, `memory_init_cow`, `table_lazy_init`, `max_wasm_stack`, `thread_stack`, the four headroom constants, `preparation_generation`, `metering_generation`, `fuel_schedule: "wasmtime-36.0.14-fuel-plus-weights"`, and `precompile_compatibility_hash` as the hex of a SHA-256 over the engine's compatibility hash bytes (the opaque fingerprint of the resolved Cranelift flags, which the public API does not expose field by field). The same record type is shaped like R14-01's `EnginePin` so a later ABCI-level artifact can carry it unchanged; FIX-05 does not add a `dashvm` dependency to `drive-abci`.

When `DASHVM_CORPUS_ARTIFACT_DIR` is set, `trap_corpus.rs` and `native_stack.rs` write `dashvm-corpus-<target_arch>.json` with three sections following R14-01's rule: `consensus` (per-case outcome, trap code, result bits, `computation_consumed`, in case order), `profile` (`target_arch`, `target_os`, detected CPU features as R14-01 records them, the `EngineProfileRecord`, `DashVmLimits` and `DashVmMeteringWeights` echoed), `diagnostic` (raw fuel per case, measured native ratios per stack case, elapsed). Serialisation canonical (`BTreeMap`, declaration order, lowercase hex), with the same encode-twice unit test.

CI: a `record-corpus` matrix job on `ubuntu-24.04` and `ubuntu-24.04-arm` (GitHub-hosted, so fork PRs are safe) running `cargo test -p dashvm --test trap_corpus --test native_stack --locked` with the artifact directory set, uploading both recordings, then a `compare-corpus` job that self-tests the comparator, compares the two `consensus` sections byte for byte, prints the `profile` and `diagnostic` sections side by side, and fails on any difference. If R14-01's `tests-rs-determinism.yml` has merged, the two jobs are added to it and its comparator gains a `--corpus` mode (same three-section rule, `schema` field distinguishes the two artifact kinds); otherwise a sibling `tests-rs-dashvm-corpus.yml` with the same structure ships here and R14-01 folds it in. Path filters: the two dashvm crates, the workflow, the comparator. The self-hosted workspace job keeps running the same tests against the same pinned vectors on whichever architecture it lands on, so a regression on either architecture is also caught on ordinary PRs.

### 3.7 Protocol table amendment

`DashVmMeteringWeights` gains `table_element_copied: u64` (provisional 8), amended in place in `DASHVM_VERSION_V1` (referenced only by protocol version 17, unreleased). Doc comment names `dash_vm.charge_elements` as the reader. The table test's non-zero-weight assertion extends to it. No `SystemLimits`, fee schedule, `feature_initial_protocol_versions`, consensus error, proto or SDK change.

## 4. Parts

All three on `v5.0-dev`, sequential; each compiles and passes CI alone; Part 1 does not depend on Parts 2 or 3; Part 2 does not depend on Part 1 (its corpus never grows memory) but is ordered after it so the golden fixture is regenerated once.

### Part 1 (base `v5.0-dev`): `feat(platform): meter guest memory growth and bulk copies deterministically in dashvm`

Files:
- `packages/rs-dashvm-validation/src/abi_names.rs` (three new `dash_vm` names and signatures), `instrumentation/mod.rs` (`INJECTED_FUNCTION_IMPORTS = 4`, report gains `length_charged_sites`, `scratch_locals`), `instrumentation/rewrite.rs` (grow replacement, bulk pre-charge, scratch local, index shift by 4), `instrumentation/frame_cost.rs` (scratch local in the frame when present), `structure.rs` (`has_length_charged_ops` per function; reject `table.grow`, `table.set`), `wasm_features.rs` (`ForbiddenFeature::TableMutation`), `errors.rs`, `admission.rs` (provenance expects the four imports, the scratch locals and the charged sites), `src/tests/fixtures/three_functions.prepared.wasm` (regenerated; add a `memory.grow` and a `memory.copy` to the WAT so the golden covers the new rewrites), `src/tests/instrumentation_tests.rs`, `src/tests/admission_tests.rs`, `README.md`.
- `packages/rs-platform-version/src/version/dashvm_versions/{mod.rs,v1.rs}` (`table_element_copied`), the table test.
- `packages/rs-dashvm/src/host/vm_imports.rs` (new: `grow`, `charge_bytes`, `charge_elements` definitions installed by the linker next to `trap` and the globals), `src/limits/memory.rs` (the backstop limiter with `approved_growth`, aggregate `pages_granted`, node-fault flag), `src/metering/budget.rs` (checked `charge` returning the `OutOfComputation` trap), `src/outcome.rs` (`NodeFault::AllocationFailed`, `NodeFault::UnapprovedGrowth`), `src/linking/initialization.rs` (initial pages approved and counted), book chapter section "Growth and copies".
- `packages/rs-dashvm/tests/resource_vectors.rs` (new): the growth and bulk vectors of section 3.5 as a first slice, plus the node-fault injections.

Tests (beside implementations and in `resource_vectors.rs`): instrumentation golden; `memory.grow` becomes a call to the fourth injected import; each bulk operator gets the tee/get/call prefix and exactly one scratch local per function that needs one, none otherwise; frame cost includes the scratch local; `table.grow`/`table.set` reject with `TableMutation`; a submitted module importing `dash_vm.grow` still rejects; provenance drift (a fifth `dash_vm` import, a missing scratch local, a bulk op without its prefix) is `Internal`; prepared bytes identical under two logical-stack limits; runtime vectors: exact charges for grow, fill, copy, init, table copy/fill; `-1` at declared max plus one, at per-instance cap plus one, at aggregate cap plus one across two instances; `OutOfComputation` on unaffordable growth with consumed equal to budget; initial pages count; OS failure inside the reservation is a node fault; unapproved growth is a node fault; a Rust-built guest (R08-01 Part 3's fixture) that allocates through its allocator prepares and runs with pinned consumption.

Estimated diff: about 1,200 lines. PR body: `Refs #4683`, provisional list (section 6, items 1 to 4), the golden regeneration rationale.

### Part 2 (base `v5.0-dev`): `feat(platform): prove native stack headroom and record the complete dashvm engine profile`

Files:
- `packages/rs-dashvm/src/limits/native_stack.rs` (constants, `NativeStackPolicy`, `required_for(&DashVmLimits) -> Result<Requirements, ProfileRejected>`), `src/engine/profile/v0.rs` (`max_wasm_stack` 8 MiB, `NativeStackPolicy` parameter, the construction-time invariant, `record()`), `src/engine/profile/record.rs` (`EngineProfileRecord`), `src/invoke.rs` (thread stack from the policy; nested store initialises its counters from the outer scope's current remaining values and writes back on return), `src/outcome.rs` (`StackOverflow` is `NodeFault::NativeStackExhausted` with the profile record attached), `src/errors.rs`, book chapter section "Native stack headroom".
- `packages/rs-dashvm/tests/native_stack.rs` (new), `tests/corpus/stack/*.wat` (the ten cases of section 3.4), `tests/corpus/artifact.rs` (shared writer for the artifact, used by Part 3 too).

Tests: the invariant rejects a policy with `max_wasm_stack` below the bound and a thread stack below its bound, accepts the profile values, and the rejection message names the violated inequality; every stack case reaches `LogicalStackExhausted` with the pinned code and consumption and never `StackOverflow` at the profile value; the measurement search reports a ratio at most half the constant for every case; nested frames share the counters (case 9); the exact-limit case (case 10); the record contains every key listed in section 3.6 and the compatibility-hash hex is stable across two engines from the same profile; the artifact encodes canonically.

Estimated diff: about 1,300 lines. PR body: `Refs #4683`, `Refs #4681` (this is the preparation-slice content the 4.4 package names: stack instrumentation headroom and a small two-architecture corpus, delivered on the 5.0 branch because the crates exist only there), provisional list items 5 to 9.

### Part 3 (base `v5.0-dev`): `test(platform): pin the cross-architecture trap and float corpus of the dashvm profile`

Files:
- `packages/rs-dashvm/tests/trap_corpus.rs` (new), `tests/corpus/{float,int,memory,table,fuel,growth,bulk}/*.wat`, `tests/corpus/vectors.json`, `tests/corpus/README.md` (how to add a case; vectors are regenerated only with a new metering or preparation generation).
- `.github/workflows/tests-rs-determinism.yml` and `.github/scripts/compare-determinism-artifacts.py` (if R14-01 has merged: `record-corpus` and `compare-corpus` jobs, `--corpus` mode, path filters) or `.github/workflows/tests-rs-dashvm-corpus.yml` and `.github/scripts/compare-dashvm-corpus.py` (otherwise). `.github/package-filters/rs-packages*.yml` already list the dashvm crates after R08-01.
- `book/src/dashvm/engine-profile-and-compiled-cache.md` (R08-01's chapter) gains "Corpus acceptance" describing the pinned vectors, the artifact and the rejection rule; `book/src/testing/determinism-and-fuzzing.md` (R14-01's chapter, if present) gains a paragraph pointing at it.

Tests: every vector of section 3.5 asserted; the reconciliation identity per case; the artifact's `consensus` section round-trips; the comparator self-test rejects a perturbed NaN bit, a perturbed consumption and a perturbed trap kind and accepts an identical pair; the workflow's perturbation step (as R14-01 does it) proves the real comparison can fail.

Estimated diff: about 1,500 lines. PR body: `Refs #4683`, `Refs #4681`, `Dash-Tasks: FIX-05`, provisional list complete, the sentence the acceptance requires: the corpus has run on x86_64 and aarch64 in CI on this PR and the vectors matched (stated only once the two hosted jobs are green; the plan does not claim it).

Total estimated diff: about 4,000 lines, fixtures included, vector JSON excluded.

## 5. Versioning consequences and what stays byte-identical

- Protocol tables: `DashVmMeteringWeights` gains one field; `DASHVM_VERSION_V1` amended in place (protocol version 17 is unreleased and is the only reference). No new table version, no new protocol version, no `SystemLimits` or `FeeVersion` change, no `feature_initial_protocol_versions` constant.
- Preparation generation 0 amended in place (unreleased): four injected function imports instead of one, bulk pre-charge, scratch locals, `table.grow`/`table.set` rejected. Prepared hashes of every module change; nothing on any network has a prepared hash yet. The golden fixture is regenerated once, in Part 1, and the PR body records that this is permitted only while generation 0 is unreleased; after activation any such change is generation 1.
- Metering generation 0 unchanged in identity (fuel plus weights); its weights table gains a member. Engine profile v0 gains headroom constants and a higher `max_wasm_stack`; both are local policy inside the profile's canonical record (they change the compiled-artifact key, which is local state, never an outcome).
- No consensus error code, proto, DAPI, SDK, wasm binding, FFI, Swift or Kotlin change. No `vN` method module anywhere in `dpp`, `drive` or `drive-abci`.
- Byte-identical: `PLATFORM_V1` to `PLATFORM_V16` and both mocks (they carry `dashvm: None` after R08-01 and are untouched here); every `SYSTEM_LIMITS_V*` and `FEE_VERSION*`; every existing `vN` implementation; R08-01's `hashing.rs`, `bundle.rs`, `bundle_preparation.rs`, `profile.rs`, `stack.rs`; R14-01's determinism test and artifact schema (`Profile.engine` stays `None`; only the comparator gains a mode); R06-01's limits and fee group.

## 6. Provisional values and interpretations (every PR body lists them)

1. `memory.grow` is host-mediated (`dash_vm.grow`) and bulk operators are pre-charged through `dash_vm.charge_bytes` / `dash_vm.charge_elements`, because Wasmtime's limiter cannot reach fuel; a weighted generation (R03-07) may replace the host calls with inline accounting.
2. `table.grow` and `table.set` are rejected in preparation generation 0 (`ForbiddenFeature::TableMutation`), an A05 refinement proposed to R03-04; Rust 1.92 guests emit neither.
3. `table_element_copied = 8` computation units (register: one unit per copied byte at pointer width).
4. Budget exhaustion on growth or copy is `OutOfComputation` (consumed equals budget); page-cap exhaustion is `-1`; OS failure inside the reservation is a node fault. `dash_vm.*` calls do not pay `host_entry`.
5. `NATIVE_BYTES_PER_LOGICAL_BYTE = 4`, `NATIVE_BYTES_PER_ACTIVATION = 256`, `HOST_BYTES_PER_NESTING = 512 KiB`, `ENTRY_SLOP_BYTES = 64 KiB`; the measurement test asserts the observed ratio is at most 2 on each CI architecture.
6. `max_wasm_stack = 8 MiB` (was 4 MiB in R08-01's plan), invocation thread stack 32 MiB, both local engine policy recorded in profile v0; the derived inequalities of section 3.4 are checked at construction.
7. CPU feature policy: explicit target triple, baseline ISA, no host inference, recorded per architecture in the profile record; R03-03 may raise the baseline after measurement as a new engine profile version.
8. `Trap::StackOverflow` is a node fault; a corpus that reaches it rejects the profile.
9. The profile record's `precompile_compatibility_hash` is an opaque SHA-256 fingerprint because Wasmtime 36 exposes the resolved ISA flags only through `Engine::precompile_compatibility_hash`.
10. Raw trap-time fuel is consensus-visible in generation 0 (the protocol cost is derived from it) and is pinned per case; it is also recorded diagnostically. Fuel flushes at block boundaries, so a mid-block trap reports the fuel at the last flush; deterministic by construction (translation-level), block-granular, bounded by the per-function operator cap, and noted for R03-07.
11. The corpus vectors are one shared fixture checked on both architectures; regenerated only together with a new preparation or metering generation.
12. The ABCI-level determinism artifact's `engine` slot stays `None`; the corpus artifact carries the engine record until ABCI executes contracts.
13. The 44-ENGINE preparation slice for FIX-05 lands on `v5.0-dev` (Parts 2 and 3 reference #4681) because the crates it instruments exist only there; `v4.4-dev` does not exist and `v4.3-dev` has neither crate.

## 7. Local gate per part

```
cargo fmt --all
cargo clippy -p dashvm-validation -p dashvm -p platform-version --all-features --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo test -p dashvm-validation
cargo test -p dashvm
cargo test -p platform-version --features mock-versions
cargo machete            # if installed; CI runs it
python3 .github/scripts/compare-determinism-artifacts.py --self-test   # Part 3, or the sibling script
```

Redirect each command's output to a file under `/tmp` and check the exit code; never end a verification in a pipe. Use `CARGO_TARGET_DIR=/Users/dashvm/work/target-fix-05` if another lane is rebuilding `platform-version` at the same time. Never run the full drive-abci suite locally. For Part 3, also run the corpus twice locally with `DASHVM_CORPUS_ARTIFACT_DIR` set to two directories and compare with `--allow-same-architecture` to catch a `HashMap`-ordered path before CI.

## 8. Dependencies

- `blocked_on`: R08-01 (all three parts). Evidence in section 2.
- `deps_not_needed`: none listed to waive. Coordination only: R14-01 (artifact shape and workflow reused if merged, otherwise a sibling workflow), R06-01 (`ComputationUnits` and the per-invocation budget reach the runtime through R08-01), R13-01 (no ABI type is needed here).
- Enables (unchanged): R08-08.

## 9. Verification checklist at unblock time

Run this against the merged tree before implementing; each item may change a file path or a decision above, none changes the acceptance.

1. `INJECTED_FUNCTION_IMPORTS`, `IndexPlan` and the provenance check: confirm the import positions R08-01 landed and extend them by three.
2. How R08-01 Part 2 charges growth. If through the limiter with a shadow counter, replace with section 3.3; if already host-mediated, keep it and add the tests. Check whether `Memory::grow` from the host passes through `memory_growing` in the landed code (it does in 36.0.14, `runtime/vm/memory.rs:613`).
3. `InvocationScope`: confirm it owns the two counters' current values and that a nested store is initialised from them and written back (R08-01 finding 5 resolution). If nested invocations share the outer store instead, adjust case 9 and the thread bound (a shared store means one `max_wasm_stack` window for the whole tree, and the second inequality drops the `max_wasm_stack` term).
4. The outcome classifier's mapping of `StackOverflow`, `OutOfFuel` and host traps; the name of the node-fault variant.
5. `max_wasm_stack` and thread size R08-01 shipped; raise to the section 3.4 values if lower and re-run the measurement.
6. Whether R08-01 Part 3's Rust-built guest fixture exists; use it for the allocator-driven growth vector.
7. Whether R14-01 merged: choose the workflow shape of section 3.6.
8. Whether `DASHVM_VERSION_V1` already has more weights than planned; append `table_element_copied` in place.
9. The book chapter names R08-01 used.
