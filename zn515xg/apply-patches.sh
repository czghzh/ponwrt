#!/bin/sh
#
# Apply the local patches this branch carries on top of the upstream feeds.
#
#   feeds/ is gitignored, so a change made directly in a feed is invisible to
#   this repository and disappears on ./scripts/feeds update.  The diffs live
#   in zn515xg/patches/<feed>/ instead; this script applies them.
#
# Usage:  ./zn515xg/apply-patches.sh [--check]
#         --check   only report, never modify anything
#
# Idempotent: already-applied patches are detected and skipped.
#
set -e

TOPDIR=$(cd "$(dirname "$0")/.." && pwd)
PATCHROOT="$TOPDIR/zn515xg/patches"
CHECK=0
[ "$1" = "--check" ] && CHECK=1

[ -d "$PATCHROOT" ] || { echo "no patches directory: $PATCHROOT" >&2; exit 1; }

rc=0
for feeddir in "$PATCHROOT"/*/; do
	[ -d "$feeddir" ] || continue
	feed=$(basename "$feeddir")
	target="$TOPDIR/feeds/$feed"

	if [ ! -d "$target" ]; then
		echo "skip    $feed (feeds/$feed not installed)"
		continue
	fi

	for p in "$feeddir"*.patch; do
		[ -f "$p" ] || continue
		name=$(basename "$p")

		if git -C "$target" apply --check --reverse "$p" 2>/dev/null; then
			echo "already $feed/$name"
		elif git -C "$target" apply --check "$p" 2>/dev/null; then
			if [ "$CHECK" = 1 ]; then
				echo "would   $feed/$name"
			else
				git -C "$target" apply "$p"
				echo "applied $feed/$name"
			fi
		else
			echo "FAILED  $feed/$name (does not apply cleanly)" >&2
			rc=1
		fi
	done
done

exit $rc
