# Runtime mechanism regression inputs

Copied byte-for-byte from the immutable 2026-09-12 autonomous audit `results/repro` directory. Original local root: `/Users/sailstellar/Documents/ChatGPT/dmg-data/experiments/autonomous-mechanisms-20260912`.

The audit used source commit `9ff9f948436ef26ab7a599b5c4ab11eba27aac90`. These inputs preserve its equipment, commands, resources and end frames; tests import the current checkout. SHA-256 values and fixed source fingerprints are in [fingerprints](../../artifacts/mechanism-fix/fingerprints.json). The full inputs remain at the original location and were replayed once each using [the portable runner](../../scripts/replay-runtime-mechanism-contracts.mjs).

The independent-stack minimum has actual ultimate frame 41 and grants at 101/128/161; its full input instead has ultimate frame 118 and grants at 178/205/238. Do not interchange these clocks.
