#!/bin/sh
# Shows marker skins and a real skin in the real game, for comparing with the preview.
# The screenshots land in ../TestBench/work/shots; `../TestBench/bench.sh clean` removes them.
cd "$(dirname "$0")/../.." || exit 1
node tools/gametest/make_mod.mjs || exit 1
exec ../TestBench/bench.sh run "$PWD/tools/gametest/steps.lua" \
  --mods FurryModB42,XochisCustomBFT,SkinStudioBenchTest --limit 360
