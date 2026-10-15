# CorTeX v4 — Asynchronous Distributed Task Scheduler

An autonomous, high-throughput task scheduler for Bitburner written in JavaScript to coordinate distributed jobs across a network of virtual servers with fragmented memory pools. 

For Bitburner: Performance-wise, the scheduler reaches a throughput of around 200-300b/sec on late-game ram pools and petabyte scales of ram.

Originally built as an advanced daemon for Bitburner, this scheduler solves real-world distributed systems challenges: concurrent job placement across uneven compute pools, race-condition prevention, self-healing node management, and noise-resilient telemetry.

---

## How It Works

### 1. Adaptive Dual-Lane Scheduling
* **Mini-Cycles (< 300 GB RAM):** At lower aggregate memory, traditional schedulers starve waiting for full target preparation. CorTeX dynamically calculates self-recovering mini-HGW cycles that farm money immediately while gradually driving security down to minimums[cite: 2].
* **Pipelined HWGW (≥ 300 GB RAM):** At higher memory capacities, it switches to pipelined batching (`Hack` → `Weaken 1` → `Grow` → `Weaken 2`) synchronized with 30ms spacing offsets[cite: 2].
* **Empirical Hand-off:** The 300 GB threshold is derived from empirical A/B simulation benchmarks measuring pool saturation against earnings per second[cite: 2].

### 2. Multi-Host Job Placement & Atomic Rollbacks
* **Combinatorial Allocation:** Dynamically splits and packs multi-threaded jobs across multiple servers when no individual host has enough contiguous free RAM[cite: 2].
* **Shadow-Pool Validation:** Pre-validates complete job placements against a temporary memory state before execution[cite: 2]. If any job in a batch fails to place, the entire batch rolls back atomically to avoid desyncing target security[cite: 2].
* **Plan Caching:** Uses an in-memory 128-entry LRU-style Map cache to avoid redundant thread-count recalculations[cite: 2].

### 3. Fault Tolerance & Self-Healing
* **Process Adoption:** Identifies existing worker processes on startup and adopts their PIDs rather than terminating running tasks[cite: 2].
* **Error Classification:** Probes failed executions and classifies them by root cause (`nofile`, `noram`, `nogone`) instead of failing silently[cite: 2].
* **Automatic Script Repair:** Periodically verifies that remote hosts actually have the worker files and automatically re-copies them if they were deleted or lost[cite: 2].

### 4. Robust Throughput Telemetry
* **Theil-Sen Median Estimator:** Standard rolling averages produce extreme spikes whenever a batch finishes[cite: 2]. CorTeX calculates the median slope of pairwise samples over a 90-second trailing window (120 samples) to provide a stable, accurate read on true income[cite: 2].
* **Reset Recovery:** Detects large wallet drops caused by game resets or hardware purchases, automatically clearing historical samples and rebuilding the rate cleanly[cite: 2].

### 5. Cooperative Concurrency & I/O Throttling
* **Event Loop Yielding:** Injects cooperative `sleep(0)` yields every 16 launches to ensure scheduling loops never lock the single-threaded execution context[cite: 2].
* **I/O Budgeting:** Caps snapshot file logging to a 400 KB sliding budget window, preventing disk thrashing and frozen logs on long-running instances[cite: 2].

---

## Project Structure

```text
cortex-scheduler/
├── README.md              # system documentation
├── src/
│   ├── cortex-v4.js       # main daemon
│   └── workers/
│       ├── h2.js          # hack worker payload
│       ├── g2.js          # grow worker payload
│       └── w2.js          # weaken worker payload
└── legacy/                #old versions that were ahh i guess
    ├── cortex-v2.js       
    ├── cortex-v3.js       
    └── cortex-v3-early.js 

Usage
Place worker scripts (h2.js, g2.js, w2.js) in the working directory or just straight up copy the code and put it in Bitburner. All it needs is the worker files and itself, no other dependencies so it'll run. 
Copy cortex-v4.js from src to Bitburner. 
Just do "run cortex-v4.js"
It's kinda chonky so run this when you have around 100gb of ram I guess. 
Configuration parameters (tick timing, reserve RAM floors, batch spacing) can be tuned directly in the C configuration object inside cortex-v4.js (tweak all u want especially the timings if you run into problems with late workers)