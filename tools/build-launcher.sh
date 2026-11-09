#!/bin/sh
# Builds the "PZ Skin Studio" program (Linux, x86-64) and its icon.
#   sh tools/build-launcher.sh
set -e
cd "$(dirname "$0")/.."
# -no-pie: file managers take a position-independent program for a library and won't run it.
gcc -O2 -s -no-pie -Wall -Wextra -Werror -o "PZ Skin Studio" launcher/launcher.c
node tools/make-icon.mjs >/dev/null
echo "built: PZ Skin Studio, launcher/icon.png"
