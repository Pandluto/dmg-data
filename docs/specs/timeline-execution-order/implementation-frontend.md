# Frontend implementation status — 2026-09-12

Scope: package A on `codex/timeline-order-frontend`. This is an implementation handoff, not complete acceptance of every specification criterion. The parent task owns integration and preview startup. Parent persistence/hydration commit `05e2a62` and the subsequent domain/preview commit must be integrated together.

## Implemented

- `timelineOperationSequence.ts` validates declared schema-v1 sequences strictly: unique nonblank IDs, exact coverage, explicit append/remove edits. Missing legacy sequences migrate in memory without changing timestamps; invalid declared sequences are never silently reconciled.
- `legacyTimelineOperationOrder.ts` is the named compatibility boundary. It reconstructs old provider ordering from a legacy plan (command start X, switch end X, then v0 tie breakers). The legacy planner fixes column width 80, page width 1120, continuation ratio 0.2. Current rendering coordinates never enter v1 admission/order. Module-only legacy input has no executed operations; the adapter still preserves all module IDs without inventing execution frames.
- `akeRealtimeTimeline.ts` supplies real start, eligible hit and end notifications to `timelineControlDispatch.ts`. Absolute operations enter the initial ready queue; dependent operations enter only on matching source notifications. Each ready batch sorts by operationOrder, then appends FIFO. Switches share that queue. Natural ends follow end-frame/dispatch order; each priority-80 completion drains newly ready priority-70 work before the next completion.
- Existing-ID draft queries substitute the new candidate and suppress its former callbacks/retries. If the edit invalidates an observed downstream execution, probing returns unknown instead of guessing. Control-sensitive drag feedback distinguishes unknown event order from main-controller mismatch.
- Switch/lane-wait-only groups can be scheduled without fake skill actions. Group-start timing retains the existing release-anchor solver's semantics.
- The provider emits `operationOrderVersion: 1` and a common `operationOrder` for commands and switches, with no new `timelineOrder` field. The execution digest includes sequence and semantic action/module inputs, not pixels, notes or timestamps; array reversal and position changes are covered by regression tests.
- Persistence, hydration, roster context, canonical canvas mirrors, DSL edits and snapshot validation are integrated in the parent task's preceding commit. Legacy migration caching also keys on catalog identity and full roster, including idle selected members.

## Verified offline

`npm run typecheck` and `git diff --check` passed. Ten focused test files passed via `node scripts/run-ts-test.mjs`:

- core/domain/{operatorControlTimeline,sharedVariableRateTimeline,timelineBatchRemoval,timelineControlDispatch,timelineOperationSequence}.test.ts
- integrations/ake/akeRealtimeTimeline.test.ts
- agentKernel/timelineWorktree/patchDsl.test.ts
- components/CanvasBoard/timelineWorkNodeSaveSafety.test.ts
- platform/timeline/timelinePayloadCompatibility.test.ts
- utils/timelineSnapshotStorage.test.ts

Regressions include the two same-frame causal-control counterexamples, separate ready-batch FIFO, editing an existing anchor across a switch, strict sequence edits/roundtrip, immutable fixed legacy migration, geometry/array invariance, module-only switch with idle target, and stale settled-flow invalidation. The existing realtime suite also covers resource, hit and form behavior. Tests are one-shot offline SSR with no listening server.

## Explicit remaining boundaries

- Settled reports do not provide an ordered source/switch event trace. If settlement changes command success/start/end/completion, the projection clears controlFlow/controlDispatch and emits `CONTROL_FLOW_REQUIRES_RUNTIME_TRACE`. Control-sensitive draft admission is then unverified, not a claim that the skill violates game rules. Full causal settled projection remains unaccepted pending a separate integration contract.
- Draft probing is a read-only replay, not a speculative full combat rerun. An edit whose effects invalidate subsequent observed events may therefore return unknown.
- No browser, RIA, live service, deployment or screenshot validation is part of this implementation handoff. Energy/shared-ATB visual retention has not been verified here. Parent task owns the requested visible preview.
- Legacy migration is tested against synthetic saved UI inputs. Raw runtime fixtures alone do not contain the original UI TimelineData and cannot prove exact historical saved-axis migration. Full v0/v1 engine fixture comparison belongs to runtime/parent integration.
- Do not mark every AC complete based on these checks. The new local preview branch is for inspection, not a declaration of complete causal-projection acceptance.
