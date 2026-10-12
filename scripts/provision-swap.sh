#!/usr/bin/env bash
# provision-swap.sh — idempotent 4GB swap for t3.micro (1GB RAM).
# Safe to re-run. Requires root (run with sudo).
set -euo pipefail

SWAPFILE="${SWAPFILE:-/swapfile}"
SIZE_GB="${SIZE_GB:-4}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

# Already active with correct size -> nothing to do.
if swapon --show=NAME,SIZE --bytes 2>/dev/null | grep -q "^${SWAPFILE} "; then
  ACTUAL_BYTES=$(swapon --show=NAME,SIZE --bytes 2>/dev/null | awk -v f="$SWAPFILE" '$1==f{print $2}')
  EXPECTED_BYTES=$(( SIZE_GB * 1024 * 1024 * 1024 ))
  if [ "${ACTUAL_BYTES:-0}" -ge "$EXPECTED_BYTES" ]; then
    echo "swap already active: $SWAPFILE ($ACTUAL_BYTES bytes)"
    grep -q "^${SWAPFILE} " /etc/fstab || echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
    exit 0
  fi
  echo "swap exists but wrong size; recreating..."
  swapoff "$SWAPFILE"
fi

# Create file if missing or wrong size.
NEED_CREATE=1
if [ -f "$SWAPFILE" ]; then
  ACTUAL_BYTES=$(stat -c%s "$SWAPFILE")
  EXPECTED_BYTES=$(( SIZE_GB * 1024 * 1024 * 1024 ))
  [ "$ACTUAL_BYTES" -eq "$EXPECTED_BYTES" ] && NEED_CREATE=0 || rm -f "$SWAPFILE"
fi

if [ "$NEED_CREATE" -eq 1 ]; then
  echo "creating ${SIZE_GB}G swap at $SWAPFILE..."
  fallocate -l "${SIZE_GB}G" "$SWAPFILE" 2>/dev/null \
    || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$(( SIZE_GB * 1024 )) status=progress
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
fi

swapon "$SWAPFILE"
grep -q "^${SWAPFILE} " /etc/fstab || echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
swapon --show
free -h
echo "swap ready."
