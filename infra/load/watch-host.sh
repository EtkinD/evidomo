#!/usr/bin/env bash
# Samples host CPU and RAM and per-container usage every few seconds while a load test runs, and
# prints the peak when you stop it (Ctrl-C). Run it on the server, in a second terminal:
#
#   infra/load/watch-host.sh [interval-seconds] [project]      defaults: 5 and evidomo-prod
#
# Lines go to the terminal and to ~/evidomo-load-watch-<timestamp>.log. Linux only (reads /proc);
# macOS has no /proc, use `docker stats` there.
set -euo pipefail

interval="${1:-5}"
project="${2:-evidomo-prod}"
[ -r /proc/stat ] || { echo "ERROR: needs Linux (/proc)" >&2; exit 1; }
log="$HOME/evidomo-load-watch-$(date -u +%Y%m%dT%H%M%SZ).log"
samples="$(mktemp)"
trap 'rm -f "$samples"' EXIT

cpu_times() { awk '/^cpu /{ idle=$5+$6; total=0; for (i=2;i<=NF;i++) total+=$i; print idle, total }' /proc/stat; }

summary() {
  echo
  echo "Peak host CPU and RAM over $(wc -l < "$samples") samples (log: $log):"
  sort -k2 -n -r "$samples" | head -1 | awk '{printf "  CPU  %s %% at %s\n", $2, $1}'
  sort -k3 -n -r "$samples" | head -1 | awk '{printf "  RAM  %s MiB used of %s MiB at %s\n", $3, $4, $1}'
}
trap 'summary | tee -a "$log"; exit 0' INT TERM

echo "Sampling every ${interval}s; Ctrl-C prints the peak." | tee -a "$log"
read -r prev_idle prev_total < <(cpu_times)
while true; do
  sleep "$interval"
  read -r idle total < <(cpu_times)
  cpu="$(awk -v i="$((idle - prev_idle))" -v t="$((total - prev_total))" 'BEGIN { printf "%.1f", (t > 0 ? 100 * (1 - i / t) : 0) }')"
  prev_idle="$idle"; prev_total="$total"
  mem_total="$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)"
  mem_used="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print int((t-a)/1024)}' /proc/meminfo)"
  now="$(date -u +%H:%M:%S)"
  echo "$now $cpu $mem_used $mem_total" >> "$samples"
  {
    echo "== $now host cpu ${cpu}%  ram ${mem_used}/${mem_total} MiB  load $(cut -d' ' -f1-3 /proc/loadavg)"
    docker stats --no-stream --format '   {{.Name}}  cpu {{.CPUPerc}}  mem {{.MemUsage}}' \
      $(docker ps -q --filter "label=com.docker.compose.project=$project") 2> /dev/null || true
  } | tee -a "$log"
done
