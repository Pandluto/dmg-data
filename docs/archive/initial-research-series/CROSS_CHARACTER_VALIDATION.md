# Cross-character clean-room validation

This fixture asks whether the generic runtime actually reads public AKE data,
or merely happens to work for Pelica. It freezes two Calc public-API scenarios
with deliberately different mechanics:

| Character | Mechanic coverage | Successful commands | HP packets | Calc total | Local result |
| --- | --- | ---: | ---: | ---: | --- |
| Chen Qianyu (`chr_0005_chen`) | five-hit melee chain, one-target channel hit, Normal Skill, multi-hit Ultimate | 7 | 16 | 407.043 | exact packet match |
| Wulfgard (`chr_0006_wolfgd`) | ranged projectile chain, Normal Skill projectiles, Ultimate local-time reset, periodic burning Buff | 6 | 26 | 284.88537 | exact packet match |

“Exact packet match” means the submitted command is accepted on the same
frame, and every HP packet has the same frame, source Skill id, damage type,
raw damage and final damage. The comparison does not merely check the total.

Run the local comparison:

```powershell
npm run verify:cross-character
```

Refresh the public snapshots and black-box observations, when deliberately
updating the fixture:

```powershell
npm run capture:cross-character-smoke
```

The capture uses only unauthenticated public endpoints. Request, response,
panel and hash-manifest files are stored under `fixtures/calc/` and
`reference/public-data/calc/api/`.

## Generic defects exposed and closed

1. Character Attribute 22 is now parsed as `MaxUltimateSp`. Chen starts at 70,
   Wulfgard at 90 and Pelica remains 80; the assembler no longer injects 80 for
   every character.
2. A serialized `ChannelingAction` with `maxCountPerTarget = 1` now executes its
   child actions immediately once against the explicit scenario target. This
   restores Chen's fifth attack and Wulfgard's burning-Buff creation without a
   character-id branch.
3. AKE `CreateBuffAction` now transfers only declared Blackboard assignments.
   `autoFinishByAction` also creates a sourced cleanup action. This prevents a
   parent Skill's unrelated `duration` key from corrupting child Buff lifetime.
4. The `RESETto1` TimeDilation node is calibrated narrowly from two frozen
   traces: later actor-local Ultimate events move by one tick. Other curves
   remain unresolved unless a provider supplies evidence.
5. The global SkillSetting lookup `燃烧每跳伤害`, column 1, is fixed at 0.24
   by Wulfgard's public trace: Atk 82.218 produces raw damage 19.73232 and final
   damage 9.86616 against the fixture's 100 Def enemy.

## Deliberately separate gaps

- The regression uses Calc's recorded duration as its evaluation horizon. The
  current automatic fight-exit heuristic can stop while a long periodic Buff
  still has future ticks; damage and Buff scheduling are exact when evaluated
  through the frozen horizon, but automatic exit timing is not claimed exact.
- Wulfgard's Normal Skill contains a target-tag check followed by conditional
  `JumpToAction` timeline seeks. This scenario casts Ultimate at frame 250,
  before the unresolved seek branch is reached. The focused interruption oracle
  in `docs/12-calc-interruption-probe.md` proves that this is an automatic
  element-state branch, not a hold/release input. No character-specific
  suppression was added to make the comparison pass.
- This is a clean-room behavioral reconstruction from public data and public
  outputs. It is not, and does not claim to be, Calc's original backend code.
