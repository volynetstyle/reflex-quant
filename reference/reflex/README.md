# Reflex reference snapshot

The source, debug files and differential test harness in this directory are copied from [Reflex](https://github.com/volynetstyle/Reflex) commit `bf718774a5bf9c15cda769712d226d9fc4d4da23`. They are used as an independent reference for Quant's tests; they are not part of the published Quant package. The upstream MIT license is included in this directory.

`baseline-runtime.mjs` is the production oracle built from that same commit using the upstream `scripts/build-baseline-oracle.mjs --production`. Benchmark builds use this fixed artifact to preserve comparability without requiring the upstream repository or its Git history. To compare a different Reflex revision, regenerate and verify this snapshot and oracle together.
