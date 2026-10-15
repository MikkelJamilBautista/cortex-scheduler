/** @param {NS} ns */
//cortex-p98(post-98)
export async function main(ns) {
    ns.disableLog("ALL");
    ns.clearLog();
    ns.ui.openTail();
    ns.ui.resizeTail(980, 640);

    const C = {
        TICK: 1000,
        // -- home reserve (B8) --
        // Old formula `raw - min(256, raw*0.5)` reserved exactly 256 GB once home
        // passed 512 GB, so the fraction was dead. Keep the same cap (so large-home
        // behaviour is unchanged) but add a real floor: homes below 64 GB previously
        // reserved half *and* had min(used, hm) clamping the reported usage.
        HOME_RESERVE_GB: 32, HOME_RESERVE_FRACTION: 0.50, HOME_RESERVE_CAP_GB: 256,
        SPACING: 40, MAX_SPACING: 160, SPACING_MIN: 20, SPACING_MAX: 160,
        ADAPTIVE_SPACING: false, FREEAT_DIAG: true, DRIFT_PORT: 8, LEAD: 1000,
        MAX_BATCHES: 600, YIELD_EVERY: 16,
        MAX_HACK_FRACTION: 0.90,
        MIN_HACK_CHANCE: 0.10,
        // Use reserved, sequential target cycles below this RAM threshold.
        // MEASURED, not guessed (sim harness, forced-mode A/B across pool sizes):
        //   pool 216 GB (8 GB/host)  -> early 80.6M/hr vs normal 84.6M/hr = 0.95x
        //   pool 270 GB (10 GB/host) -> 0.99x
        //   pool 324 GB (12 GB/host) -> early falls to 0.86x, then 0.72x at 378 GB
        //   pool 432 GB+ -> 0.67x and declining
        // Early mode holds parity up to ~300 GB and loses from ~324 GB on, because
        // above that the normal batch pipeline keeps more cycles in flight. 300 GB
        // is therefore the hand-off point; below it the pipelined path starves.
        EARLY_MODE_MAX_RAM_GB: 300,
        // -- EARLY implementation switch --
        // "mini" = adaptive mini-HGW cycles (no full-prep gate; pays out immediately)
        // "legacy" = the original sequential PREP->HACK->W1->GROW->W2 state machine
        EARLY_IMPL: "mini",
        EARLY_MINI_PARTNERS: 3,        // concurrent mini-cycle partners
        EARLY_SEC_SHARE: 0.25,         // fraction of an existing security deficit each cycle pays down
        EARLY_MIN_MONEY_FRACTION: 0.50,
        EARLY_GROW_MONEY_FRACTION: 0.999999,
        EARLY_SEC_EPS: 1e-6,
        EARLY_MAX_CYCLE_MS: 60_000,
        EARLY_SECONDARY_MIN_STEAL: 0.01,
        EARLY_SECONDARY_PRIMARY_RATIO: 0.05,
        GROW_PAD: 1.01, GROW_EXTRA_THREADS: 1,
        PREP_SEC_EPS: 0.05, PREP_MONEY_FRAC: 0.99, WEAKEN_FIRST_ABOVE: 3,
        BATCH_RAM_SHARE: 0.85, PREP_SHARE: 0.35, DRIFT_TICKS: 5,
        XP_FARM: true, XP_KEEP_FREE: 0.15, LEDGER_GRACE: 2000,

        // -- IO & UI Throttling --
        GUI_UPDATE_MS: 5000,           // redraw tail every 5s (min 250)
        EVENT_WRITE_MS: 5000,          // flush event log every 5s
        SNAPSHOT_EVERY_TICKS: 20,      // write snapshot every N ticks (~20s)
        SNAPSHOT_MIN_WRITE_MS: 2000,   // D7: floor between event-triggered rewrites
        COPY_VERIFY_TICKS: 30,         // re-verify worker files on each host every N ticks
        API_DEAD_TICKS: 8,             // ticks of zero API income (with observed income) before switching
        LOG_WINDOW_MS: 10 * 60 * 1000, // D7: budget window for snapshot rewrites
        LOG_MAX_BYTES_PER_WINDOW: 400_000, // D7: cap on snapshot bytes per window
        PORT_MAX_DRAIN: 64,            // B7: cap port reads per tick
        LEDGER_SWEEP_TICKS: 10,        // B3: liveness reconcile cadence (was fixed 60)
        MIN_SLEEP_MS: 250,
        REACTIVE_TICK_MS: 250,         // B6: shortened wait while RAM is sitting idle
        // B6 pacing experiment flag. With pacing on, no target may refill more than
        // its own in-flight depth + slack per tick; with it off, the launch pass is
        // bounded only by RAM and MAX_BATCHES, as in the original. Rotation runs
        // either way. Measured in the sim harness: pacing ON saturated 85.25% of the
        // pool, pacing OFF 88.02% at +3.7% income, so OFF is the default. The pacing
        // path is kept behind the flag because it is what stops one target from
        // monopolising the pool if a future network needs that.
        DEPTH_PACING: false,
        PACE_DEPTH_SLACK: 2,           // B6: per-target in-flight batch cap = depth + slack
        BATCH_RAM_MARGIN: 0.98,        // B4: fraction of measured prep spend charged against headroom
        LOG_RETENTION_MS: 60 * 60 * 1000,
        LOG_FILE: "/logs/cortex-v3-snapshots.txt",
        EVENT_LOG: "/logs/cortex-v3-events.txt",
        SNAPSHOT_MAX_BYTES: 1_200_000,
        EVENT_MAX_BYTES: 250_000,
    };
    C.WPT = ns.weakenAnalyze(1);
    // Per-thread security increases, queried rather than assumed. These are the
    // last hardcoded values that affect batch sizing: every other batch input
    // (op times, chance, money, weaken strength) is already read from game state,
    // so leaving these as literals was the one remaining silent failure mode - a
    // changed value would mis-size every w1/w2 by the same factor, showing up as
    // unexplained drift rather than as a math error. One startup query each; every
    // use reads C.HACK_SEC / C.GROW_SEC exactly like it reads C.WPT.
    C.HACK_SEC = ns.hackAnalyzeSecurity(1);
    C.GROW_SEC = ns.growthAnalyzeSecurity(1);
    const F = { h: "h2.js", g: "g2.js", w: "w2.js" };
    const files = Object.values(F);
    for (const f of files) {
        if (!ns.fileExists(f, "home")) {
            ns.tprint(`ERROR: ${f} missing on home.`);
            return;
        }
    }

    // -- B1/B2: own-name detection + worker ownership --
    // The old guard hardcoded "cortex-v2.js"/"cortex-v3.js", so it could not see
    // a second copy of *this* scheduler running under a different filename, and it
    // scanned for h.js/g.js/w.js while killing h2/g2/w2.js. Own name now comes
    // from the running script, and the legacy names are kept only as a warn list.
    const scriptName = ns.getRunningScript()?.filename || "scheduler-fix-beta.js";
    const SELFPID = ns.getRunningScript()?.pid ?? 0;
    const LEGACY_WORKERS = ["h.js", "g.js", "w.js"];
    const LEGACY_SCHEDULERS = ["cortex-v2.js", "cortex-v3.js", "cortex-v3-early-fixed.js"];

    const hosts = scan(ns);
    const ownWorkers = [];
    const otherSchedulers = [];
    const legacyJobs = [];
    for (const host of hosts) {
        if (!ns.hasRootAccess(host)) continue;
        for (const p of ns.ps(host)) {
            if (files.includes(p.filename)) ownWorkers.push(`${host}:${p.filename}#${p.pid}`);
            if (LEGACY_WORKERS.includes(p.filename)) legacyJobs.push(`${host}:${p.filename}#${p.pid}`);
            if (p.pid === SELFPID) continue;
            if (p.filename === scriptName || LEGACY_SCHEDULERS.includes(p.filename)) {
                otherSchedulers.push(`${host}:${p.filename}#${p.pid}`);
            }
        }
    }
    if (otherSchedulers.length) {
        ns.tprint(`Single-instance guard: refusing to start while another scheduler is live: ${otherSchedulers.slice(0, 8).join(", ")}`);
        return;
    }
    if (legacyJobs.length) {
        ns.tprint(`Legacy workers are running (${legacyJobs.slice(0, 8).join(", ")}); they are not touched, but they still occupy RAM.`);
    }
    const pendingStartupNotes = [];
    if (ownWorkers.length) {
        pendingStartupNotes.push(`Adopting ${ownWorkers.length} orphaned own worker(s) from a previous run instead of killing them.`);
    }
    pendingStartupNotes.push(`Single-instance guard passed (script=${scriptName} pid=${SELFPID}).`);

    const R = { h: ns.getScriptRam(F.h), g: ns.getScriptRam(F.g), w: ns.getScriptRam(F.w) };
    const SCRIPT_RAM = Math.max(R.h, R.g, R.w);
    const ctx = { uid: Date.now(), copied: new Set(), ledger: [], recent: [], fails: 0, execs: 0, xp: null, xpTarget: null, staleDropped: 0, mini: {}, failByCause: { nofile: 0, noram: 0, nogone: 0, unknown: 0 }, missingFiles: new Set(), recopies: 0 };
    const state = {};
    const miniState = {};
    let miniMode = false;             // set per tick by the early lane
    let tick = 0, totalBatches = 0, lateTotal = 0, driftTotal = 0, lateEvents = 0;
    let batchStartIndex = 0;
    let lastFails = 0;
    let lastTargetMode = null, lastEarlyTargets = "";
    const startTime = Date.now();

    const events = [];
    const eventLog = [];
    let historyBuffer = [];
    let eventsDirty = false;
    let tickEvents = [];
    let lastSnapshotWrite = 0;
    let logWindowStart = 0, logWindowBytes = 0, logSuppressed = 0, logBudgetBypass = 0;
    let lastSnapshotTextLength = 0;

    // -- IO throttle anchors --
    let lastGuiUpdate = 0;
    let lastEventWrite = 0;

    // -- B1: event() no longer runs before launch; ns/ui exist by then --
    const event = msg => {        const time = Date.now();
        const line = `[${new Date(time).toLocaleTimeString()}] ${msg}`;
        events.push(line);
        if (events.length > 6) events.shift();
        tickEvents.push(line);
        eventLog.push({ t: time, text: line + "\n" });
        eventsDirty = true;
    };
    const recordBatchTiming = job => {
        if (!job.batch || job.spacingSampled) return;
        job.spacingSampled = true;
    };

    // -- B7: bounded drain instead of an unbounded while --
    const drainPort = () => {
        let n = 0;
        while (n < C.PORT_MAX_DRAIN) {
            if (ns.readPort(7) === "NULL PORT DATA") break;
            n++;
        }
        return n;
    };
    const drainDrift = () => {
        for (let n = 0; n < C.PORT_MAX_DRAIN; n++) {
            const v = ns.readPort(C.DRIFT_PORT);
            if (v === "NULL PORT DATA") break;
            if (Number.isFinite(Number(v))) spacingSample(ctx, C, Number(v), event);
        }
    };

    // Startup: adopt own workers, never kill them, and never kill another instance's.
    drainPort();
    drainDrift();
    event("Cortex V4-beta Core initialized successfully.");
    for (const note of pendingStartupNotes) event(note);

    while (true) {
        const tickStart = Date.now();
        tick++;
        tickEvents = [];

        // -- GUI throttle --
        const shouldUpdateGui = (tickStart - lastGuiUpdate) >= C.GUI_UPDATE_MS;
        if (shouldUpdateGui) {
            ns.clearLog();
            lastGuiUpdate = tickStart;
        }

        let currentTickOutput = "";
        const logLine = (text = "") => {
            if (shouldUpdateGui) ns.print(text);
            currentTickOutput += text.replace(/\u001b\[[0-9;]*m/g, "") + "\n";
        };
        const fileLine = (text = "") => { currentTickOutput += text + "\n"; };

        const formulas = ns.fileExists("Formulas.exe", "home");
        const servers = scan(ns);
        const pool = [];
        const hostMax = Object.create(null);
        const hostReserve = Object.create(null);

        // -- B3: liveness-truthful ledger --
        // The old pass kept any entry whose stamp had not aged past LEDGER_GRACE,
        // so a finished pipeline stayed "inflight" for up to 2s: that pinned the
        // state machine in drain, skewed ranking, and re-credited dead early jobs
        // into the reservation pool. The ledger is now purely live-work, while
        // historical counters come from ctx.recent.
        const nowMs = Date.now();
        let keep = 0;
        for (const j of ctx.ledger) {
            if (j.dead) continue;
            if (j.batch && !j.spacingSampled && j.host && !ns.isRunning(j.pid, j.host)) {
                recordBatchTiming(j);
            }
            if (j.end + C.LEDGER_GRACE <= nowMs) {
                j.dead = true;
                j.completedAt = nowMs;
                ctx.recent.push(j);
                continue;
            }
            if (nowMs - j.start > 5000) {
                if (j.host && !ns.isRunning(j.pid, j.host)) {
                    j.dead = true;
                    j.completedAt = nowMs;
                    ctx.staleDropped++;
                    ctx.recent.push(j);
                    continue;
                }
            }
            ctx.ledger[keep++] = j;
        }
        ctx.ledger.length = keep;

        if (tick % C.LEDGER_SWEEP_TICKS === 0) {
            const live = new Set();
            for (const host of servers) for (const p of ns.ps(host)) live.add(p.pid);
            ctx.ledger = ctx.ledger.filter(j => {
                if (live.has(j.pid)) return true;
                j.dead = true;
                j.completedAt = nowMs;
                ctx.staleDropped++;
                ctx.recent.push(j);
                return false;
            });
        }
        ctx.recent = ctx.recent.filter(j => (j.completedAt || nowMs) > nowMs - 10_000);
        if (ctx.recent.length > 4000) ctx.recent.splice(0, ctx.recent.length - 4000);

        // -- income tracker --
        // Sampled here, before this tick's deploys, so every sample is taken at the
        // same point in the loop. See snapshotIncome() for why the game's own
        // getTotalScriptIncome() is not used for the displayed rate.
        // Cortex's own lifetime hack income, straight from the game rather than
        // inferred, so it cannot drift out of step with reality.
        let totalEarned = 0;
        try {
            const src = ns.getMoneySources();
            const ss = src && src.sinceStart;
            if (ss) {
                // Bitburner names this key "hacking" in current builds; older or
                // alternate shapes use "hack". Reading only "hack" made the read
                // silently undefined, and Number.isFinite(undefined) turned that
                // into a permanent 0 without ever raising. Accept either.
                const v = Number.isFinite(ss.hacking) ? ss.hacking
                    : (Number.isFinite(ss.hack) ? ss.hack : undefined);
                if (v !== undefined) totalEarned = v;
                else if (!ctx.moneyKeyWarned) {
                    ctx.moneyKeyWarned = true;
                    event(`INCOME: getMoneySources().sinceStart has no numeric hack/hacking key (keys: ${Object.keys(ss).join(",")}); relying on observed income.`);
                }
            }
        } catch { }

        // Live and display counters must be separated: the state machine gates on
        // work that is *actually running*, while the GUI smooths over completions.
        // Mixing the two is what pinned targets in "prep" with an open pool.
        const stats = {};
        let totalH = 0, totalG = 0, totalW = 0;
        for (const j of ctx.ledger) {
            const s = stats[j.t] ??= { h: 0, g: 0, w: 0, batches: 0 };
            s[j.type] += j.n;
            s.batches += j.b;
            if (j.type === "h") totalH += j.n;
            else if (j.type === "g") totalG += j.n;
            else totalW += j.n;
        }
        const displayStats = {};
        for (const j of ctx.recent) {
            const s = displayStats[j.t] ??= { h: 0, g: 0, w: 0, batches: 0 };
            s[j.type] += j.n * 0.5;
            s.batches += (j.b || 0) * 0.5;
        }
        for (const [name, live] of Object.entries(stats)) {
            const s = displayStats[name] ??= { h: 0, g: 0, w: 0, batches: 0 };
            s.h += live.h; s.g += live.g; s.w += live.w; s.batches += live.batches;
        }

        // -- B7: the port is telemetry, and it does not measure lateness --
        const late = drainPort();
        drainDrift();
        lateTotal += late;
        if (late >= 5) {
            lateEvents++;
            event(`WARN: port 7 backlog of ${late} message(s) drained (queue depth, not lateness).`);
        }

        let maxRam = 0, usedRam = 0;
        // -- copy guard (was a permanent-trust cache) --
        // The old code copied workers to a host once per session and then trusted
        // ctx.copied forever. An augment install wipes every script from every
        // host while the cache still claims they are there, so those hosts accept
        // no work for the rest of the session: RAM sits frozen and every exec on
        // them fails. Verify instead of trusting.
        //   - hosts flagged by an exec failure are re-verified immediately
        //   - every host is re-verified on a slow rotation (COPY_VERIFY_TICKS)
        // getServerFiles is a cheap host-side listing; where it is unavailable we
        // fall back to fileExists per worker.
        const hostHasWorkers = host => {
            try {
                if (typeof ns.getServerFiles === "function") {
                    const list = ns.getServerFiles(host);
                    if (Array.isArray(list)) return files.every(f => list.includes(f));
                }
            } catch { }
            try {
                return files.every(f => ns.fileExists(f, host));
            } catch {
                return true;   // cannot verify: do not force a copy storm
            }
        };
        for (const host of servers) {
            if (!ns.hasRootAccess(host)) continue;
            const flagged = ctx.missingFiles.has(host);
            const rotating = tick % C.COPY_VERIFY_TICKS === 0;
            const claimed = ctx.copied.has(host);
            const shouldVerify = host === "home" ? false : (flagged || !claimed || rotating);
            if (host !== "home" && !shouldVerify) {
                ctx.cacheTrustedHits = (ctx.cacheTrustedHits || 0) + 1;
                ns.__probe?.("cacheTrusted");
            }

            if (host !== "home" && shouldVerify) {
                ctx.verifyScans = (ctx.verifyScans || 0) + 1;
                ns.__probe?.("verifyScans");
                const present = hostHasWorkers(host);
                if (!present) {
                    const copied = await ns.scp(files, host, "home");
                    if (!copied) {
                        if (flagged) {
                            event(`ERROR: could not restore workers on ${host}; excluding it from allocation.`);
                        }
                        ctx.copied.delete(host);
                        continue;
                    }
                    ctx.copied.add(host);
                    ctx.recopies++;
                    ns.__probe?.("recopies");
                    ctx.missingFiles.delete(host);
                    if (flagged) event(`RECOVERED: workers restored on ${host} after exec failures.`);
                } else {
                    // Files are there after all; drop any stale failure flag.
                    if (flagged) {
                        ctx.missingFiles.delete(host);
                        ctx.copied.add(host);
                    }
                }
            }
            const raw = ns.getServerMaxRam(host);
            if (raw <= 0) continue;
            // -- B8: home reserve --
            // max(floor, fraction) under an explicit cap, instead of the old
            // min(cap, fraction) which silently pinned large homes to the cap.
            const reserve = Math.min(C.HOME_RESERVE_CAP_GB,
                Math.max(C.HOME_RESERVE_GB, raw * C.HOME_RESERVE_FRACTION));
            const hm = host === "home" ? Math.max(0, raw - reserve) : raw;
            hostMax[host] = raw;
            hostReserve[host] = (host === "home" ? reserve : 0) + 0.5;
            // Report true usage; the old min(used, hm) clamp could print used > total.
            const used = ns.getServerUsedRam(host);
            const hu = Math.min(used, hm);
            maxRam += hm;
            usedRam += hu;
            if (used > hm) ctx.reserveBreached = true;
            pool.push({ name: host, free: Math.max(0, hm - hu - 0.5), max: hm, home: host === "home" });
        }
        // Ero98's host-pinned phases motivate this diagnostic; allocation stays unchanged.
        const freeAt = (host, T) => {
            let used = 0;
            for (const j of ctx.ledger) {
                if (j.host !== host) continue;
                if (j.start <= T && T < j.end) used += j.ram * j.n;
            }
            return Math.max(0, (hostMax[host] - hostReserve[host]) - used);
        };

        // -- Cortex's own landed income --
        // Two independent sources, because they can disagree in the field:
        //   observed - money that left the servers our own hack workers struck,
        //              measured on the target between ticks. This depends on no
        //              game API and works whatever the worker does with the money.
        //   api      - getMoneySources().sinceStart.hack. Accurate when the build
        //              reports it, and observed sitting at 0 on builds where the
        //              workers bank by a route the counter does not track.
        // The observed figure is authoritative when the API has plainly failed;
        // otherwise the API is preferred since it survives reloads.
        const apiEarned = totalEarned;
        const observedTotal = ctx.observedEarned || 0;
        if (apiEarned > 0) ctx.apiIncomeWorks = true;

        // Decide once, and only on evidence this process can actually see: the
        // API counter has stayed at exactly 0 for a sustained stretch while we
        // were demonstrably landing hacks. The wallet cannot be used as the
        // corroborating signal, because in a broken-counter build our own income
        // also moves the wallet, so a wallet-only test can latch onto the ordinary
        // pre-first-landing window and never re-evaluate.
        if (!ctx.incomeSource) {
            if (ctx.apiIncomeWorks) {
                ctx.incomeSource = "api";
            } else if ((ctx.observedEarned || 0) > 0) {
                ctx.zeroApiTicks = (ctx.zeroApiTicks || 0) + 1;
                if (ctx.zeroApiTicks >= C.API_DEAD_TICKS) ctx.incomeSource = "observed";
            }
        }
        const useObserved = ctx.incomeSource === "observed";
        const ownEarned = useObserved ? observedTotal : apiEarned;
        if (useObserved && !ctx.apiDeadNotified) {
            ctx.apiDeadNotified = true;
            event("INCOME: getMoneySources().hack reads 0 while the wallet grows; switching attribution to observed hack income.");
        }

        const earnedNow = Math.max(0, ownEarned - (ctx.earnedSeen || 0));
        if (earnedNow > 0) ctx.earned = (ctx.earned || 0) + earnedNow;
        ctx.earnedSeen = ownEarned;
        // Rate is computed after accumulating so the sampled series cannot lag a
        // tick behind and read 0 whenever a landing coincides with a sample.
        ctx.incomeRate = snapshotIncome(ctx, ns, tick, ctx.earned || 0);
        // Tracker keeps its rate on the tracker object; mirror it onto ctx so one
        // read path serves the GUI, the snapshot and the summary.
        const cortexRate = Math.max(0, (ctx.income && ctx.income.earnedRate) || 0);
        ctx.earnedRate = cortexRate;

        // -- observed hack income --
        // Deltas of moneyAvailable on the servers our hack workers struck. Only
        // drops count, and only on targets where a hack landed, so other scripts
        // and our own grows cannot pollute the figure.

        const statOf = n => stats[n] || { h: 0, g: 0, w: 0, batches: 0 };
        const statOfDisplay = n => displayStats[n] || { h: 0, g: 0, w: 0, batches: 0 };
        const player = ns.getPlayer();
        const hackLvl = player.skills.hacking;
        const targets = [];
        const targetMoneyNow = {};
        ctx.hackTargetsNow = [];
        for (const name of servers) {
            if (name === "home" || !ns.hasRootAccess(name)) continue;
            const maxM = ns.getServerMaxMoney(name);
            if (maxM <= 0) continue;
            const si = ns.getServer(name);
            if (si.requiredHackingSkill > hackLvl) continue;
            const mock = { ...si, hackDifficulty: si.minDifficulty, moneyAvailable: si.moneyMax };
            const wNow = ns.getWeakenTime(name);
            let wT, gT, hT, chance;
            if (formulas) {
                wT = ns.formulas.hacking.weakenTime(mock, player);
                gT = ns.formulas.hacking.growTime(mock, player);
                hT = ns.formulas.hacking.hackTime(mock, player);
                chance = ns.formulas.hacking.hackChance(mock, player);
            } else {
                const ratio = (2.5 * si.requiredHackingSkill * si.minDifficulty + 500) /
                    (2.5 * si.requiredHackingSkill * si.hackDifficulty + 500);
                wT = wNow * ratio;
                gT = ns.getGrowTime(name) * ratio;
                hT = ns.getHackTime(name) * ratio;
                const currentChance = ns.hackAnalyzeChance(name);
                const chanceScale = (100 - si.minDifficulty) / Math.max(1e-9, 100 - si.hackDifficulty);
                chance = Math.min(1, currentChance * chanceScale);
            }
            const earlyModeEligible = !formulas && maxRam < C.EARLY_MODE_MAX_RAM_GB;
            if (!Number.isFinite(chance) || chance <= 0 ||
                (!earlyModeEligible && chance < C.MIN_HACK_CHANCE)) continue;
            const hackPerThread = formulas
                ? ns.formulas.hacking.hackPercent(mock, player)
                : ns.hackAnalyze(name) * (100 - si.minDifficulty) / Math.max(1e-9, 100 - si.hackDifficulty);
            targets.push({ name, maxM, minSec: si.minDifficulty, curSec: si.hackDifficulty,
                curMoney: si.moneyAvailable, wT, gT, hT, wNow, chance, hackPerThread, mock,
                planCache: new Map() });
            targetMoneyNow[name] = si.moneyAvailable;
        }

        // -- observed hack income (needs the target list above) --
        if (ctx.prevTargetMoney) {
            for (const name of ctx.hackTargetsPrev || []) {
                const prev = ctx.prevTargetMoney[name];
                const now = targetMoneyNow[name];
                if (prev === undefined || now === undefined) continue;
                if (now < prev) ctx.observedEarned = (ctx.observedEarned || 0) + (prev - now);
            }
        }
        ctx.prevTargetMoney = targetMoneyNow;
        // Record which targets have hack threads in flight, to check next tick.
        const hackHot = [];
        for (const t of targets) {
            const s = stats[t.name];
            if (s && s.h > 0) hackHot.push(t.name);
        }
        ctx.hackTargetsPrev = hackHot.slice(0, 64);
        // The API is only declared dead once the wallet has demonstrably grown.
        if ((ctx.incomeRate || 0) > 0) ctx.walletHasGrown = true;

        for (const t of targets) {
            const referenceHackThreads = Math.max(1, Math.floor(0.10 / t.hackPerThread));
            const p = cachedPlan(ns, t, referenceHackThreads, C, R, player, formulas);
            t.score = p && p.ramSec > 0 ? p.frac * t.maxM * t.chance / p.ramSec : 0;
        }
        targets.sort((a, b) => b.score - a.score);

        const selection = selectTargets(ns, targets, C, formulas, maxRam, pool, R, ctx, state);
        const { targets: scheduledTargets, mode: targetMode } = selection;
        const selectedEarlyTargets = targetMode === "EARLY"
            ? scheduledTargets.map(t => t.name) : [];
        const selectedEarlyTargetSet = new Set(selectedEarlyTargets);
    miniMode = targetMode === "EARLY" && C.EARLY_IMPL === "mini";
    const partnerMode = miniMode;
    const activeEarlyTargetSet = miniMode ? new Set(Object.keys(miniState)) : selectedEarlyTargetSet;
        const selectedEarlyLabel = selectedEarlyTargets.length
            ? selectedEarlyTargets.join(",") : null;
        const scheduledTargetNames = new Set(scheduledTargets.map(t => t.name));
        const prepMoneyFraction = targetMode === "EARLY"
            ? C.EARLY_GROW_MONEY_FRACTION : C.PREP_MONEY_FRAC;
        if (targetMode !== lastTargetMode) {
            event(`TARGET MODE: ${targetMode} (pool ${maxRam.toFixed(1)} GB).`);
            lastTargetMode = targetMode;
        }
        if (targetMode === "EARLY" && selectedEarlyLabel !== lastEarlyTargets) {
            event(selectedEarlyLabel
                ? `EARLY TARGETS: ${selectedEarlyLabel} active; ${selection.reason || "RAM reservations updated"}.`
                : `EARLY TARGETS: none feasible (${selection.reason}).`);
            lastEarlyTargets = selectedEarlyLabel || "";
        }
        if (targetMode !== "EARLY") lastEarlyTargets = "";

        for (const t of targets) {
            const st = state[t.name] ??= { mode: "prep", bad: 0, nextLand: 0, pct: 0, secTol: 0, earlyCycle: null };
            const sx = statOf(t.name);
            const inflight = sx.h + sx.g + sx.w;
            if (targetMode === "EARLY" && st.earlyCycle && !selectedEarlyTargetSet.has(t.name)) {
                if (!st.earlyCycle.drainNotified) {
                    event(`EARLY DRAIN: ${t.name} demoted (${st.earlyCycle.drainReason || "lower-ranked or no longer fits"}); current phase will finish before its reservation is released.`);
                    st.earlyCycle.drainNotified = true;
                }
                st.mode = "drain";
                continue;
            }
            if (st.earlyCycle?.draining) {
                if (!st.earlyCycle.drainNotified) {
                    event(`EARLY DRAIN: ${t.name} demoted (${st.earlyCycle.drainReason || "normal mode selected"}); current phase will finish before its reservation is released.`);
                    st.earlyCycle.drainNotified = true;
                }
                st.mode = "drain";
                continue;
            }
            if (!scheduledTargetNames.has(t.name)) {
                const prevMode = st.mode;
                st.mode = inflight > 0 ? "drain" : "prep";
                if (prevMode !== st.mode) event(`STATE: ${t.name} [${prevMode}] -> [${st.mode}]`);
                continue;
            }
            const ok = t.curMoney >= t.maxM * prepMoneyFraction && t.curSec <= t.minSec + C.PREP_SEC_EPS;
            const prevMode = st.mode;
            if (st.mode === "prep") {
                if (ok && inflight === 0) {
                    Object.assign(st, { mode: "batch", bad: 0, pct: 0, secTol: 0, nextLand: 0 });
                }
            } else if (st.mode === "batch") {
                if (targetMode === "EARLY") {
                    st.bad = 0;
                } else if (inflight === 0) {
                    st.bad = 0;
                    if (!ok) st.mode = "prep";
                } else if (st.pct > 0) {
                    const healthy = t.curMoney >= t.maxM * (1 - st.pct) * 0.90 && t.curSec <= t.minSec + st.secTol + 0.2;
                    st.bad = healthy ? 0 : st.bad + 1;
                    if (st.bad >= C.DRIFT_TICKS) {
                        st.mode = "drain";
                        driftTotal++;
                        event(`DRIFT: ${t.name} unhealthy. Mode -> DRAIN.`);
                    }
                }
            } else if (inflight === 0) st.mode = "prep";
            if (prevMode !== st.mode) event(`STATE: ${t.name} [${prevMode}] -> [${st.mode}]`);
        }

        for (const t of scheduledTargets) {
            if (targetMode !== "EARLY" || miniMode) break;
            const st = state[t.name];
            const plan = selection.plans[t.name];
            if (!st.earlyCycle) {
                const server = ns.getServer(t.name);
                const ready = server.moneyAvailable >= server.moneyMax * C.EARLY_GROW_MONEY_FRACTION &&
                    server.hackDifficulty <= server.minDifficulty + C.EARLY_SEC_EPS;
                st.earlyCycle = {
                    target: t.name,
                    phase: ready ? "HACK" : "PREP",
                    pids: [],
                    activePhase: null,
                    threads: plan.threads,
                    fraction: plan.fraction,
                    blocker: null,
                    started: false,
                    plan,
                    reservation: selection.reservations[t.name],
                    draining: false,
                };
            } else {
                st.earlyCycle.plan = plan;
                st.earlyCycle.threads = plan.threads;
                st.earlyCycle.fraction = plan.fraction;
                st.earlyCycle.reservation = selection.reservations[t.name];
            }
        }

        for (const t of targets) {
            const st = state[t.name];
            const cycle = st?.earlyCycle;
            if (!cycle || cycle.draining) continue;
            cycle.pids = cycle.pids.filter(({ pid, host }) => ns.isRunning(pid, host));
            if (cycle.pids.length === 0 && (cycle.phase === "SELECT" || targetMode !== "EARLY")) {
                st.earlyCycle = null;
                if (targetMode !== "EARLY") {
                    const server = ns.getServer(t.name);
                    if (server.moneyAvailable < server.moneyMax * C.PREP_MONEY_FRAC ||
                        server.hackDifficulty > server.minDifficulty + C.PREP_SEC_EPS) {
                        Object.assign(st, { mode: "prep", pct: 0, secTol: 0, nextLand: 0 });
                    }
                }
            }
        }

        const drainingEarlyTargets = new Set(targets
            .filter(t => state[t.name]?.earlyCycle?.draining)
            .map(t => t.name));
        const batchTargets = scheduledTargets.filter(t =>
            state[t.name].mode === "batch" && !drainingEarlyTargets.has(t.name)
        );
        const unprepped = scheduledTargets.filter(t => state[t.name].mode !== "batch");
        const needPrep = unprepped.some(t => state[t.name].mode === "prep");
        const freeStart = pool.reduce((a, p) => a + p.free, 0);
        // -- B4: prep ceiling is a cap, not a claim --
        // The old code subtracted a fixed PREP_SHARE from batch headroom whether or
        // not prep spent it, and prep itself drew from the same pool with no shared
        // spend tracking. Now prep spends against one explicit ceiling and the
        // batch loop is charged only what was actually consumed.
        let prepCeilingGB = batchTargets.length ? freeStart * C.PREP_SHARE : freeStart;
        let prepSpentGB = 0;
        const prep = (script, ram, threads, target, dur) => {
            if (!Number.isFinite(threads) || threads <= 0) return 0;
            const n = Math.min(Math.ceil(threads), Math.floor(prepCeilingGB / ram));
            if (n <= 0) return 0;
            const done = prepDeploy(ns, pool, ctx, script, ram, n, target, dur);
            prepCeilingGB -= done * ram;
            prepSpentGB += done * ram;
            return done;
        };
        for (const t of targetMode === "EARLY" ? [] : unprepped) {
            if (state[t.name].mode !== "prep") continue;
            const sx = statOf(t.name);
            const secDiff = Math.max(0, t.curSec - t.minSec);
            const strayHackSec = sx.h * C.HACK_SEC;
            if (secDiff > C.WEAKEN_FIRST_ABOVE) {
                const need = Math.ceil((secDiff + strayHackSec + sx.g * C.GROW_SEC) / C.WPT);
                prep(F.w, R.w, need - sx.w, t.name, t.wT);
            } else {
                let addG = 0;
                if (t.curMoney < t.maxM * prepMoneyFraction) {
                    const totalG = Math.ceil(ns.growthAnalyze(t.name, t.maxM / Math.max(t.curMoney, 1)));
                    if (Number.isFinite(totalG)) addG = Math.max(0, totalG - sx.g);
                }
                const needW = Math.ceil((secDiff + strayHackSec + (sx.g + addG) * C.GROW_SEC) / C.WPT);
                prep(F.w, R.w, needW - sx.w, t.name, t.wT);
                prep(F.g, R.g, addG, t.name, t.gT);
            }
        }

        const prepReserveGB = targetMode === "EARLY"
            ? 0
            : Math.min(maxRam * (1 - C.BATCH_RAM_SHARE), prepSpentGB * C.BATCH_RAM_MARGIN);
        let freeGB = pool.reduce((sum, host) => sum + host.free, 0);
        let saturated = false, launchedThisTick = 0, burst = 0, needsRefillSoon = false;
        const activePipelines = [];
        let batchBlocker = null;

        const earlyCycleStatuses = [];
        let miniLaunched = 0;
        if (miniMode) {
            // -- reworked EARLY lane: adaptive mini-HGW cycles --
            // No full-prep gate. Every cycle that lands is a complete H/W1/G/W2
            // group sized to fit the RAM and the vault floor, so it pays out from
            // the first cycle instead of waiting for secDiff <= epsilon.
            const miniPool = pool.map(h => ({ ...h }));
            try {
                miniLaunched = runEarlyMiniBatches(ns, ctx, targets, miniState, miniPool, C, R, F);
            } catch (err) {
                // A throw here must not silently stop the scheduler: surface it
                // once and keep the loop alive.
                if (!ctx.miniError) {
                    ctx.miniError = true;
                    event(`EARLY(engine) ERROR: ${err && err.message ? err.message : err}. Falling back to legacy early lane this tick.`);
                    console.error('[early-mini]', err);
                }
                miniLaunched = 0;
            }
            if (!miniLaunched) saturated = true;
            for (const [name, ms] of Object.entries(miniState)) {
                const t = targets.find(x => x.name === name);
                earlyCycleStatuses.push({
                    target: name,
                    phase: ms.blocked ? "WAIT" : (ms.phase || "CYCLE"),
                    blocked: !!ms.blocked,
                    detail: ms.outcome || "mini-cycle",
                    plan: ms.plan ? {
                        threads: ms.plan.h, fraction: ms.plan.frac,
                        cycleMs: 0, expectedPerSecond: t ? t.score : 0,
                        hackActions: ms.plan.h, growActions: ms.plan.g,
                        weakenHackActions: ms.plan.w1, weakenGrowActions: ms.plan.w2,
                        withinCycleLimit: true,
                    } : null,
                    reservedGB: ms.plan ? ms.plan.ram : 0,
                });
            }
        } else if (targetMode === "EARLY") {
            for (const t of scheduledTargets) {
                const st = state[t.name], cycle = st.earlyCycle;
                if (!cycle) continue;
                const targetPool = reservedEarlyPool(pool, cycle.reservation, selection.slotRam);
                const before = ctx.ledger.length;
                const status = runEarlyCycleTick(ns, targetPool, ctx, t, st, C, R, F);
                for (const job of ctx.ledger.slice(before)) {
                    if (!job.early) continue;
                    const host = pool.find(item => item.name === job.host);
                    if (host) host.free = Math.max(0, host.free - job.n * job.ram);
                }
                status.target = t.name;
                status.plan = cycle.plan;
                status.reservedGB = Object.values(cycle.reservation || {}).reduce(
                    (sum, slots) => sum + slots * selection.slotRam, 0);
                earlyCycleStatuses.push(status);
                if (status.blocked) saturated = true;
            }
            for (const [name, st] of Object.entries(state)) {
                const cycle = st.earlyCycle;
                if (!cycle || !cycle.draining) continue;
                cycle.pids = cycle.pids.filter(({ pid, host }) => ns.isRunning(pid, host));
                if (cycle.pids.length === 0) {
                    event(`EARLY DRAIN COMPLETE: ${name}; released ${Object.values(cycle.reservation || {}).reduce((sum, slots) => sum + slots * selection.slotRam, 0).toFixed(1)} GB reservation.`);
                    st.earlyCycle = null;
                    st.mode = "prep";
                } else {
                    earlyCycleStatuses.push({
                        target: name,
                        phase: "DRAIN",
                        detail: `finishing ${cycle.pids.length} in-flight worker group(s)`,
                        plan: cycle.plan,
                        reservedGB: Object.values(cycle.reservation || {}).reduce(
                            (sum, slots) => sum + slots * selection.slotRam, 0),
                    });
                }
            }
        } else {
            // -- B6: depth is a real cap, and dispatch rotates --
            // depth was display-only, so the top-scoring target could absorb the
            // whole pool every pass. Each partner now gets a refill allowance
            // derived from its own pipeline depth, and the starting position
            // rotates so no single target is structurally first every tick.
            const rotate = batchTargets.length
                ? (batchStartIndex++ % batchTargets.length) : 0;
            const ordered = batchTargets.slice(rotate).concat(batchTargets.slice(0, rotate));
        for (const t of ordered) {
            const st = state[t.name], sx = statOf(t.name);
            const depth = Math.max(1, Math.floor(t.wT / (4 * C.SPACING)));
            // First refill of a pipeline is always allowed; afterwards a target is
            // paced to roughly its in-flight depth so landing slots stay spaced.
            const paceLimit = !C.DEPTH_PACING
                ? Infinity
                : (st.depth === undefined ? Infinity : (st.depth + C.PACE_DEPTH_SLACK));
            const lead = t.wNow * 1.02 + C.LEAD + 2 * C.SPACING;
            const horizon = lead + C.TICK + 4 * C.SPACING;
            let launched = 0;
            let displayPlan = null;
            let reusePlan = null;
            while (launchedThisTick < C.MAX_BATCHES && launched < paceLimit) {
                const now = Date.now();
                const L = Math.max(st.nextLand, now + lead);
                if (L - now > horizon) break;

                const availableGB = freeGB - prepReserveGB;
                const minPlan = cachedPlan(ns, t, 1, C, R, player, formulas);
                const diagnostic = {
                    availableGB,
                    freeGB,
                    prepReserveGB,
                    hostCount: pool.length,
                    largestHostFree: pool.reduce((largest, host) => Math.max(largest, host.free), 0),
                    hostFreeSummary: pool.slice().sort((a, b) => b.free - a.free).slice(0, 5)
                        .map(host => `${host.name}:${host.free.toFixed(2)}GB`).join(","),
                    minPlan,
                    lastPlacementFailure: null,
                    lastRejectedPlan: null,
                };
                const cachedJobs = reusePlan && reusePlan.ram <= availableGB + 1e-9
                    ? makeBatchJobs(reusePlan, t, C, R, F, L)
                    : null;
                const cachedPlacement = cachedJobs ? planBatchPlacement(pool, cachedJobs) : null;
                const selected = cachedPlacement && cachedPlacement.placements
                    ? { plan: reusePlan, placements: cachedPlacement.placements }
                    : findBestPlan(ns, t, C, R, player, formulas, F, pool, availableGB, L, diagnostic);
                if (!selected) {
                    saturated = true;
                    needsRefillSoon = true;
                    batchBlocker = { target: t.name, ...diagnostic };
                    break;
                }
                const chosen = selected.plan;
                reusePlan = chosen;

                let faN = 0, faSum = 0, faMax = 0, faNeg = 0;
                if (C.FREEAT_DIAG) {
                    for (const a of selected.placements) {
                        const host = pool.find(p => p.name === a.host);
                        if (!host) continue;
                        const gain = freeAt(a.host, a.job.land) - host.free;
                        faN++; faSum += gain; faMax = Math.max(faMax, gain);
                        if (gain < 0) faNeg++;
                    }
                }
                if (!launchBatch(ns, pool, ctx, t.name, selected.placements)) {
                    saturated = true;
                    batchBlocker = { target: t.name, ...diagnostic, reason: "Placement became stale or worker launch failed." };
                    break;
                }
                if (faN) {
                    ctx.fa ??= { n: 0, sum: 0, max: 0, neg: 0 };
                    ctx.fa.n += faN; ctx.fa.sum += faSum;
                    ctx.fa.max = Math.max(ctx.fa.max, faMax); ctx.fa.neg += faNeg;
                }

                displayPlan = chosen;
                st.pct = sx.batches === 0 && launched === 0
                    ? chosen.pct : Math.max(st.pct, chosen.pct);
                st.secTol = sx.batches === 0 && launched === 0
                    ? chosen.secTol : Math.max(st.secTol, chosen.secTol);
                if (st.lastPct !== chosen.pct) st.lastPct = chosen.pct;
                freeGB -= chosen.ram;
                launched++;
                launchedThisTick++;
                st.depth = depth;
                st.nextLand = L + 4 * C.SPACING;
                if (++burst >= C.YIELD_EVERY) { burst = 0; await ns.sleep(0); }
            }
            if ((sx.batches > 0 || launched > 0) && displayPlan) {
                activePipelines.push({ t, st, plan: displayPlan, launched, maxBatches: depth });
            }
        }
        }

        if (C.XP_FARM && formulas) {
            const managedTargets = new Set(targets.map(t => t.name));
            if (tick % 60 === 1 || (ctx.xpTarget && managedTargets.has(ctx.xpTarget))) {
                ctx.xpTarget = pickXpTarget(ns, servers, player, managedTargets);
            }
            ctx.xp = ctx.xpTarget;
            // -- B9: XP budget baseline --
            // Old code subtracted XP_KEEP_FREE * maxRam (allocated, not free) from a
            // freeGB the batch loop had already spent down. Track the pre-batch free
            // pool so the floor means what it says, and never exceed live free RAM.
            const liveFree = pool.reduce((sum, p) => sum + p.free, 0);
            const xpFloor = Math.max(freeStart, liveFree) * C.XP_KEEP_FREE;
            let budget = Math.max(0, Math.min(freeGB, liveFree) - xpFloor);
            if (ctx.xpTarget) {
                const xpDuration = ns.getWeakenTime(ctx.xpTarget);
                for (const p of pool.slice().sort((a, b) => b.free - a.free)) {
                    if (budget < R.w) break;
                    const n = Math.floor(Math.min(p.free, budget) / R.w);
                    if (n < 1) continue;
                    const pid = run(ns, ctx, p.name, F.w, n, ctx.xpTarget, 0, xpDuration);
                    if (pid) {
                        p.free -= n * R.w;
                        budget -= n * R.w;
                        ctx.ledger.push({ pid, host: p.name, start: Date.now(), end: Date.now() + xpDuration + 500, t: "__xp", type: 'w', n, b: 0, ram: R.w });
                    }
                }
            }
        }

        totalBatches += launchedThisTick;
        if (ctx.fails > lastFails) {
            const failSpike = ctx.fails - lastFails;
            if (failSpike >= 5) event(`WARN: +${failSpike} execution failures this tick.`);
            lastFails = ctx.fails;
        }

        // ====================================================================
        // CORTEX V4 GUI
        // Fixed-column layout, 82 characters wide so a tail of ~960px never wraps.
        // Every line is composed from a visible-length-aware pad so ANSI colour
        // codes never shift the columns.
        // ====================================================================
        const nm = (x, d = 2) => ns.format.number(x, d);
        const rm = x => ns.format.ram(x);

        // Progress bar: one-cell eighth-block glyphs over a filled/empty track.
        // Full block = complete cell, partial blocks = fractions, light shade = empty.
        const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
        const TRACK = "░";
        const progBar = (frac, w = 10) => {
            const f = Math.max(0, Math.min(1, frac));
            const eighths = Math.round(f * w * 8);
            const full = Math.floor(eighths / 8);
            const part = eighths % 8;
            let bar = "█".repeat(full);
            if (part > 0 && full < w) bar += PARTIAL[part];
            const used = bar.length;
            return bar + TRACK.repeat(Math.max(0, w - used));
        };
        const thrFmt = n => {
            if (!Number.isFinite(n) || n <= 0) return "0";
            if (n < 1000) return String(Math.round(n));
            if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 2 : 1) + "k";
            if (n < 1e9) return (n / 1e6).toFixed(2) + "m";
            return (n / 1e9).toFixed(2) + "b";
        };
        const shortNum = n => {
            const a = Math.abs(n);
            if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
            if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
            if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
            if (a >= 1e3) return (n / 1e3).toFixed(2) + "k";
            return n.toFixed(0);
        };

        const A = {
            reset: "\u001b[0m",
            dim:   "\u001b[2m",
            red:   "\u001b[1;31m",
            grn:   "\u001b[1;32m",
            yel:   "\u001b[1;33m",
            blu:   "\u001b[1;34m",
            mag:   "\u001b[1;35m",
            cyn:   "\u001b[1;36m",
            wht:   "\u001b[1;37m",
            gry:   "\u001b[38;5;245m",
            sub:   "\u001b[38;5;240m",
            bg:    "\u001b[48;5;236m",
        };
        const visLen = s => s.replace(/\u001b\[[0-9;]*m/g, "").length;
        const padR = (s, w) => { const v = visLen(s); return v >= w ? s : s + " ".repeat(w - v); };
        const padL = (s, w) => { const v = visLen(s); return v >= w ? s : " ".repeat(w - v) + s; };
        const padLR = (l, r, w) => l + " ".repeat(Math.max(1, w - visLen(l) - visLen(r))) + r;
        const truncate = (s, w) => {
            const v = visLen(s);
            if (v <= w) return s;
            // Cut on the visible prefix only; callers pass uncoloured text.
            return s.slice(0, Math.max(0, w - 1)) + "...";
        };

        const W = 88;
        const IN = W - 2;                                  // inner width after the 2-space gutter
        const panelRow = (content, gutter = 1) =>
            `  ${A.sub}│${A.reset}` + " ".repeat(gutter) + padR(content, IN - gutter * 2) + " ".repeat(gutter) + `${A.sub}│${A.reset}`;
        const clock = new Date(Date.now());
        const pad2 = n => String(n).padStart(2, "0");
        const stamp = `${pad2(clock.getHours())}:${pad2(clock.getMinutes())}:${pad2(clock.getSeconds())}`;
        // Unicode borders sharpen the fixed-width panel.
        // Single-cell glyphs preserve the existing column geometry in the game tail.
        // The in-game font must render each glyph as one cell.
        const DIV = `  ${A.sub}${"─".repeat(W)}${A.reset}`;
        const TOP = `  ${A.sub}╭${"─".repeat(IN)}╮${A.reset}`;
        const MID = `  ${A.sub}├${"─".repeat(IN)}┤${A.reset}`;
        const BOT = `  ${A.sub}╰${"─".repeat(IN)}╯${A.reset}`;
        // Compact money for table cells: exact to 3 significant decimals, suffixed.
        const money2 = n => {
            const a = Math.abs(n);
            if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
            if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
            if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
            if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
            return n.toFixed(0);
        };

        const sumCur = targets.reduce((s, t) => s + t.curMoney, 0);
        const sumMax = targets.reduce((s, t) => s + t.maxM, 0);
        const poolFree = pool.reduce((s, p) => s + p.free, 0);
        const ramLoad = maxRam > 0 ? usedRam / maxRam * 100 : 0;
        const poolFrac = sumMax > 0 ? sumCur / sumMax : 0;
        const ramFrac = Math.max(0, Math.min(1, ramLoad / 100));
        const bank = ns.getServerMoneyAvailable("home");
        // -- income tracker (sampled earlier this tick, see snapshotIncome) --
        const income = ctx.incomeRate;
        const hrRate = income * 3600;
        const totalActiveThreads = totalH + totalG + totalW;
        const prepFrac = maxRam > 0 ? Math.max(0, prepSpentGB) / maxRam : 0;
        const usedFrac = maxRam > 0 ? Math.max(0, usedRam) / maxRam : 0;
        const batchFrac = Math.max(0, usedFrac - prepFrac);

        const band = (f, good = 0.9, ok = 0.5) => f >= good ? A.grn : (f >= ok ? A.yel : A.red);
        const perHr = Math.abs(hrRate);
        const perDay = Math.abs(income) * 86400;
        const pctLabelLocal = f => {
            const p = f * 100;
            if (p > 0 && p < 0.01) return "<0.01%";
            if (p < 1) return p.toFixed(3) + "%";
            return p.toFixed(1) + "%";
        };

        // --------------------------------
        // Header - title, attribution, lane
        // --------------------------------
        const earlyActive = partnerMode || (targetMode === "EARLY" && earlyCycleStatuses.length > 0);
        const laneTag = partnerMode
            ? `${A.cyn}EARLY.MINI${A.reset}`
            : targetMode === "EARLY"
                ? `${A.yel}EARLY.SEQ${A.reset}`
                : `${A.dim}PIPELINE${A.reset}`;
        const engineTag = formulas ? `${A.grn}FORMULAS${A.reset}` : `${A.yel}HEURISTIC${A.reset}`;
        const phaseStr = batchTargets.length > 0
            ? (needPrep ? `${A.yel}PREP+FARM${A.reset}` : `${A.grn}FARM${A.reset}`)
            : `${A.yel}PREP${A.reset}`;

        // --------------------------------
        // Boxed header + metrics
        // --------------------------------
        logLine(TOP);
        logLine(panelRow(padLR(
            `${A.wht}CorTeX${A.reset} ${A.sub}v4${A.reset} ${A.sub}by${A.reset} ${A.cyn}hige${A.reset}`,
            `${laneTag} ${A.dim}.${A.reset} ${engineTag} ${A.dim}.${A.reset} ${phaseStr}`,
            IN - 2
        )));
        if (earlyActive) {
            const label = partnerMode ? Object.keys(miniState).join(", ") : selectedEarlyTargets.join(", ");
            logLine(panelRow(`${A.dim}partners${A.reset} ${A.gry}${truncate(label || "none admitted", IN - 22)}${A.reset} ` +
                `${A.dim}. hand-off ${C.EARLY_MODE_MAX_RAM_GB}GB${A.reset}`));
        }
        logLine(MID);
        // Each rate carries its own unit and its own sign, so no arrow is needed.
        const upStr = dur(Date.now() - startTime);
        const rateColor = income > 0 ? A.grn : (income < 0 ? A.red : A.gry);
        logLine(panelRow(
            `${A.dim}RATE${A.reset}  ${rateColor}${income >= 0 ? "+" : "-"}$${nm(Math.abs(income))}${A.reset}${A.dim}/sec${A.reset}` +
            `   ${rateColor}${hrRate >= 0 ? "+" : "-"}$${shortNum(perHr)}${A.reset}${A.dim}/hr${A.reset}` +
            `   ${rateColor}${perDay >= 0 ? "+" : "-"}$${shortNum(perDay)}${A.reset}${A.dim}/day${A.reset}`
        ));
        logLine(panelRow(
            `${A.dim}STATE${A.reset} ${A.dim}wallet${A.reset} ${A.wht}$${shortNum(bank)}${A.reset}` +
            `   ${A.dim}hack${A.reset} ${A.wht}${hackLvl}${A.reset}` +
            `   ${A.dim}ram/t${A.reset} ${A.gry}${SCRIPT_RAM.toFixed(1)}GB${A.reset}` +
            `   ${A.dim}xp${A.reset} ${ctx.xp ? `${A.cyn}${ctx.xp}${A.reset}` : `${A.sub}-${A.reset}`}` +
            `   ${A.dim}batches${A.reset} ${A.wht}${shortNum(totalBatches)}${A.reset}`
        ));
        logLine(panelRow(padLR(
            `${A.dim}uptime${A.reset} ${A.cyn}${upStr}${A.reset}`,
            `${A.dim}tick${A.reset} ${A.gry}${tick}${A.reset} ${A.dim}.${A.reset} ${A.gry}${stamp}${A.reset}`,
            IN - 2
        )));
        logLine(BOT);
        // Attribution: the residual "other" rate is `wallet - cortex`, clamped to
        // zero for display because a stacked bar can only show positive shares.
        const lifetime = Math.max(0, ctx.earned || 0);
        {
            const BAR_W = 10;
            const cortexHourly = Math.max(0, cortexRate) * 3600;
            const walletHourly = income * 3600;
            const rawOther = walletHourly - cortexHourly;
            const spending = walletHourly < 0;
            const otherHourly = Math.max(0, rawOther);

            // Segment split at cell resolution, so the percentages describe the bar
            // as drawn rather than the underlying ratio.
            const denom = cortexHourly + otherHourly;
            const share = (denom > 0 && Number.isFinite(denom)) ? (cortexHourly / denom) : 1;
            const cortCells = spending ? 0 : Math.round(share * BAR_W);
            const otherCells = spending ? BAR_W : (BAR_W - cortCells);
            const cortPct = spending ? 0 : Math.round((cortCells / BAR_W) * 100);
            const otherPct = 100 - cortPct;

            const bar = spending
                ? `${A.sub}${"█".repeat(BAR_W)}${A.reset}`
                : `${A.cyn}${"█".repeat(cortCells)}${A.yel}${"█".repeat(otherCells)}${A.reset}`;

            const cortLabel = `${A.cyn}cort${A.reset} ${A.cyn}$${shortNum(cortexHourly)}${A.reset}${A.dim}/hr${A.reset}`;
            const otherLabel = spending
                ? `${A.red}spending${A.reset} ${A.red}$${shortNum(Math.abs(walletHourly))}${A.reset}${A.dim}/hr${A.reset}`
                : `${A.yel}other${A.reset} ${A.yel}$${shortNum(otherHourly)}${A.reset}${A.dim}/hr${A.reset}`;
            const splitLabel = spending
                ? `${A.sub}all spend${A.reset}`
                : `${A.cyn}${cortPct}%${A.reset}${A.dim}/${A.reset}${A.yel}${otherPct}%${A.reset}`;

            const prefix = spending ? `${A.red}attrib${A.reset}` : `${A.dim}attrib${A.reset}`;
            logLine(padLR(
                `  ${prefix} ${bar} ${splitLabel}  ${cortLabel}  ${otherLabel}`,
                `${A.dim}lifetime${A.reset} ${A.wht}$${shortNum(lifetime)}${A.reset}` +
                (ctx.income && ctx.income.resets ? ` ${A.yel}o${ctx.income.resets} reset${ctx.income.resets > 1 ? "s" : ""}${A.reset}` : ""),
                W + 2
            ));
        }
        // The reset banner is informational, not a state: clear it once the income
        // window has refilled, otherwise it renders forever after one detection.
        if (ctx.augResetSeen && ctx.income && ctx.income.samples.length >= 20) {
            ctx.augResetSeen = false;
        }
        if (ctx.augResetSeen) {
            logLine(`  ${A.yel}!${A.reset} ${A.dim}income history reset (augment install or node reset) - rate rebuilding${A.reset}`);
        }
        // --------------------------------
        // Target table
        // --------------------------------
        const COL = { name: 20, mode: 11, vault: 18, sec: 8, threads: 12 };
        logLine(panelRow(`${A.dim}${"TARGET".padEnd(COL.name)} ${"MODE".padEnd(COL.mode)} ${"VAULT".padEnd(COL.vault)} ${"SEC".padEnd(COL.sec)} ${"THREADS".padEnd(COL.threads)}${A.reset}`));
        const aboutOf = st => {            const wait = st.nextLand - Date.now();
            if (st.mode === "batch") {
                if (Number.isFinite(st.lastPct) && st.lastPct > 0) return pctLabelLocal(st.lastPct);
                return "ready";
            }
            if (st.mode === "prep") return "prep";
            if (st.mode === "drain") return "drain";
            if (wait > 0 && Number.isFinite(wait)) return `${(wait / 1000).toFixed(1)}s`;
            return "";
        };
        const displayList = targets
            .map(t => {
                const st = state[t.name] ?? { mode: "prep", bad: 0, nextLand: 0, pct: 0, secTol: 0 };
                const pipeline = activePipelines.find(p => p.t.name === t.name);
                const earlyStatus = earlyCycleStatuses.find(item => item.target === t.name);
                const sx = statOfDisplay(t.name);
                const threads = (sx.h || 0) + (sx.g || 0) + (sx.w || 0);
                const active = !!(pipeline || earlyStatus) || threads > 0;
                // A lane is any target with work actually in flight. activePipelines
                // only covers targets that accepted a *new* batch this tick, so it
                // under-reports on ticks where a pipeline simply kept running.
                const lane = active && (st.mode === "batch" || !!pipeline || !!earlyStatus);
                return { t, st, pipeline, earlyStatus, sx, threads, active, lane };
            })
            .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.t.score - a.t.score)
            .slice(0, 14);
        const laneCount = displayList.filter(item => item.lane).length;

        for (const item of displayList) {
            const { t, st, pipeline, earlyStatus, sx } = item;
            const frac = t.maxM > 0 ? t.curMoney / t.maxM : 0;
            const secDelta = t.curSec - t.minSec;

            let mode, modeColor;
            if (earlyStatus) {
                mode = earlyStatus.blocked ? "WAIT" : (earlyStatus.phase || "RUN");
                modeColor = earlyStatus.blocked ? A.yel : A.cyn;
            } else if (pipeline) {
                mode = "FOCUS";
                modeColor = A.cyn;
            } else if (st.mode === "batch") {
                mode = "READY";
                modeColor = A.grn;
            } else if (st.mode === "drain") {
                mode = "DRAIN";
                modeColor = A.yel;
            } else {
                mode = "PREP";
                modeColor = A.dim;
            }

            // Vault cell: bar + percent + absolute money, or an idle placeholder.
            const vaultCell = item.active || frac > 0.001
                ? `${band(frac)}${progBar(frac, 8)}${A.reset} ${band(frac)}${(frac * 100).toFixed(0).padStart(3)}%${A.reset} ${A.gry}${money2(t.curMoney)}${A.reset}`
                : `${A.sub}${"·".repeat(8)}${A.reset} ${A.sub}idle${A.reset}`;

            // Security cell: 3-cell heat bar + signed delta.
            const secFrac = Math.max(0.05, Math.min(1, secDelta / Math.max(1, C.WEAKEN_FIRST_ABOVE)));
            const secColor = secDelta <= 0.1 ? A.grn : (secDelta <= 1 ? A.yel : A.red);
            const secCell = `${secColor}${progBar(secFrac, 3)}${A.reset} ${secColor}${(secDelta >= 0 ? "+" : "")}${secDelta.toFixed(2)}${A.reset}`;

            const thrCells = sx.h + sx.g + sx.w > 0
                ? `${A.gry}${thrFmt(sx.h)}${A.sub}/${A.gry}${thrFmt(sx.g)}${A.sub}/${A.gry}${thrFmt(sx.w)}${A.reset}`
                : `${A.sub}-${A.reset}`;
            // Reserve a fixed 7-cell slot for the trailing activity hint so the
            // THREADS column always starts at the same offset.
            const hintRaw = item.active ? aboutOf(st) : "";
            const hint = hintRaw ? `${A.dim}${hintRaw}${A.reset}` : "";

            logLine(panelRow(
                `${padR(t.name, COL.name)} ` +
                `${padR(`${modeColor}${mode}${A.reset}`, COL.mode)} ` +
                `${padR(vaultCell, COL.vault)} ` +
                `${padR(secCell, COL.sec)} ` +
                `${padR(thrCells, COL.threads)} ` +
                `${padL(hint, 6)}`
            ));
        }
        if (!displayList.length) logLine(panelRow(`${A.sub}(no rooted targets meet the hacking level yet)${A.reset}`));
        logLine(BOT);

        // --------------------------------
        // RAM + throughput
        // --------------------------------
        logLine(DIV);
        const ramFill = Math.round(batchFrac * 14);
        const ramPrep = Math.round(prepFrac * 14);
        const ramBar = `${A.cyn}${"█".repeat(ramFill)}${A.yel}${"█".repeat(ramPrep)}` +
            `${A.sub}${"░".repeat(Math.max(0, 14 - ramFill - ramPrep))}${A.reset}`;
        logLine(padLR(
            `  ${A.dim}ram${A.reset} ${ramBar} ${band(ramFrac)}${ramLoad.toFixed(1)}%${A.reset}` +
            `  ${A.cyn}batch${A.reset} ${rm(Math.max(0, usedRam - prepSpentGB))}` +
            `  ${A.yel}prep${A.reset} ${rm(prepSpentGB)}`,
            `${A.sub}free${A.reset} ${A.gry}${rm(poolFree)}${A.reset}`,
            W + 2
        ));
        logLine(padLR(
            `  ${A.dim}pool${A.reset} ${band(poolFrac)}${progBar(poolFrac, 8)}${A.reset} ${(poolFrac * 100).toFixed(1)}%` +
            `  ${A.gry}$${shortNum(sumCur)}${A.dim}/${A.reset}${A.gry}$${shortNum(sumMax)}${A.reset}`,
            `${A.dim}hosts${A.reset} ${A.gry}${pool.length}${A.reset}  ` +
            `${A.dim}lanes${A.reset} ${A.cyn}${laneCount}${A.reset}` +
            (partnerMode ? `${A.dim}+${A.reset}${A.yel}${Object.keys(miniState).length}${A.reset}` : ""),
            W + 2
        ));
        const threadBar = (n, w, color) => `${color}${progBar(totalActiveThreads > 0 ? n / totalActiveThreads : 0, w)}${A.reset}`;
        logLine(padLR(
            `  ${A.dim}H${A.reset}${threadBar(totalH, 6, A.mag)}${padL(thrFmt(totalH), 6)}` +
            ` ${A.dim}G${A.reset}${threadBar(totalG, 6, A.grn)}${padL(thrFmt(totalG), 6)}` +
            ` ${A.dim}W${A.reset}${threadBar(totalW, 6, A.cyn)}${padL(thrFmt(totalW), 6)}`,
            `${A.dim}ZL${A.reset} ${A.wht}${thrFmt(totalActiveThreads)}${A.reset}` +
            `  ${A.dim}execs${A.reset} ${A.gry}${shortNum(ctx.execs)}${A.reset}` +
            `  ${A.dim}fails${A.reset} ${ctx.fails > 0 ? A.red + ctx.fails : A.gry + ctx.fails}${A.reset}` +
            `  ${A.dim}port${A.reset} ${lateEvents > 0 ? A.yel : A.gry}${lateEvents}${A.reset}`,
            W + 2
        ));
        // Failure attribution. A high fail count is only actionable once you can see
        // WHY: a missing worker file and a genuinely full host need opposite fixes.
        {
            const fc = ctx.failByCause;
            const failPct = ctx.execs > 0 ? (ctx.fails / ctx.execs) * 100 : 0;
            if (ctx.fails > 0) {
                const parts = [];
                if (fc.nofile) parts.push(`${A.red}nofile${A.reset} ${fc.nofile}`);
                if (fc.noram) parts.push(`${A.yel}noram${A.reset} ${fc.noram}`);
                if (fc.nogone) parts.push(`${A.gry}hostgone${A.reset} ${fc.nogone}`);
                if (fc.unknown) parts.push(`${A.gry}other${A.reset} ${fc.unknown}`);
                const sev = failPct >= 50 ? A.red : (failPct >= 10 ? A.yel : A.gry);
                logLine(`  ${A.dim}failwhy${A.reset} ${sev}${failPct.toFixed(1)}%${A.reset} ${A.dim}of exec${A.reset}  ${parts.join("  ")}` +
                    (ctx.recopies > 0 ? `  ${A.grn}repairs${A.reset} ${A.grn}${ctx.recopies}${A.reset}` : "") +
                    (ctx.missingFiles.size > 0 ? `  ${A.red}hosts missing workers: ${ctx.missingFiles.size}${A.reset}` : ""));
            } else if (ctx.recopies > 0) {
                logLine(`  ${A.dim}failwhy${A.reset} ${A.grn}clean${A.reset} ${A.dim}- worker files repaired on${A.reset} ${A.grn}${ctx.recopies}${A.reset} ${A.dim}host(s) this session${A.reset}`);
            }
        }
        if (saturated || batchBlocker) {
            const blockerTarget = batchBlocker ? batchBlocker.target : null;
            const headroom = batchBlocker ? Math.max(0, batchBlocker.availableGB) : 0;
            logLine(`  ${A.yel}◆${A.reset} ${A.dim}backpressure${A.reset} ` +
                `${A.gry}${blockerTarget ? `${blockerTarget} · ${rm(headroom)} headroom` : "pool saturated"}${A.reset}` +
                (prepReserveGB > 0 ? `  ${A.dim}prep reserve${A.reset} ${A.gry}${rm(prepReserveGB)}${A.reset}` : ""));
        } else {
            logLine(`  ${A.grn}✓${A.reset} ${A.dim}backpressure${A.reset} ${A.gry}clear - headroom available${A.reset}`);
        }

        // --------------------------------
        // Events
        // --------------------------------
        logLine(DIV);
        const shown = events.slice(-Math.max(1, 3));
        for (let i = 0; i < shown.length; i++) {
            logLine(`  ${(i === shown.length - 1 ? `${A.dim}event${A.reset}` : "     ")} ${A.gry}${truncate(shown[i], W - 8)}${A.reset}`);
        }

        fileLine(`\n-- SNAPSHOT tick #${tick} @ ${stamp} --`);
        fileLine(`RAM: Free ${poolFree.toFixed(1)}GB | Batch headroom ${Math.max(0, poolFree - prepReserveGB).toFixed(1)}GB | Saturated: ${saturated} | PrepReserve ${prepReserveGB.toFixed(1)}GB | TargetMode:${targetMode}`);
        for (const cycleStatus of earlyCycleStatuses) {
            const plan = cycleStatus.plan;
            const estimate = plan
                ? ` | estimate~$${plan.expectedPerSecond.toExponential(4)}/s cycle=${(plan.cycleMs / 1000).toFixed(2)}s H=${plan.threads} hack=${pctLabel(plan.fraction)} reserved=${cycleStatus.reservedGB.toFixed(1)}GB actions=H${plan.hackActions}/Wh${plan.weakenHackActions}/G${plan.growActions}/Wg${plan.weakenGrowActions}${!plan.withinCycleLimit ? ` over-preferred-limit=${C.EARLY_MAX_CYCLE_MS / 1000}s` : ""}`
                : "";
            fileLine(`EARLY CYCLE ${cycleStatus.target || "-"}: phase=${cycleStatus.phase} | ${cycleStatus.detail}${estimate}`);
        }
        if (batchBlocker) {
            const minPlan = batchBlocker.minPlan;
            const failure = batchBlocker.lastPlacementFailure;
            fileLine(`BATCH BLOCKER ${batchBlocker.target}: ${batchBlocker.reason || "No complete candidate fits."} | headroom=${batchBlocker.availableGB.toFixed(2)}GB poolFree=${batchBlocker.freeGB.toFixed(2)}GB prepReserve=${batchBlocker.prepReserveGB.toFixed(2)}GB hosts=${batchBlocker.hostCount} largestHostFree=${batchBlocker.largestHostFree.toFixed(2)}GB`);
            fileLine(`HOST FREE (top 5): ${batchBlocker.hostFreeSummary || "(none)"}`);
            if (minPlan) fileLine(`MIN BATCH: ${pctLabel(minPlan.pct)} H${minPlan.h}/W1:${minPlan.w1}/G${minPlan.g}/W2:${minPlan.w2} RAM=${minPlan.ram.toFixed(2)}GB`);
            if (batchBlocker.lastRejectedPlan) {
                const plan = batchBlocker.lastRejectedPlan.plan;
                fileLine(`BEST REJECTED: ${pctLabel(plan.pct)} H${plan.h}/W1:${plan.w1}/G${plan.g}/W2:${plan.w2} RAM=${plan.ram.toFixed(2)}GB`);
            }
            if (failure) fileLine(`PLACEMENT: failed at ${failure.type} requiring ${failure.requiredThreads} threads; remaining host capacity=${failure.availableThreads} threads; best progress=${failure.jobsPlaced}/${failure.jobCount} jobs`);
        }
        fileLine(`Threads H:${totalH} G:${totalG} W:${totalW} | ExecFails:${ctx.fails} | PortDrained:${lateTotal} (backlogs:${lateEvents}) | StaleLedgerDropped:${ctx.staleDropped} | XP:${ctx.xp || "-"}`);
        fileLine(`BatchMath: WPT=${C.WPT} HACK_SEC=${C.HACK_SEC} GROW_SEC=${C.GROW_SEC}`);
        fileLine(`IncomeRate: source=${ctx.incomeSource || "api"} wallet=$${(ctx.incomeRate || 0).toFixed(2)}/s cortex=$${(ctx.earnedRate || 0).toFixed(2)}/s lifetime=$${(ctx.earned || 0).toFixed(0)} observed=$${(ctx.observedEarned || 0).toFixed(0)} apiHack=$${totalEarned.toFixed(0)} samples=${ctx.income ? ctx.income.samples.length : 0} resets=${ctx.income ? ctx.income.resets : 0}`);
        fileLine(`ExecHealth: calls=${ctx.execs} fails=${ctx.fails} pct=${(ctx.execs ? (ctx.fails / ctx.execs * 100).toFixed(2) : "0")}% nofile=${ctx.failByCause.nofile} noram=${ctx.failByCause.noram} hostgone=${ctx.failByCause.nogone} other=${ctx.failByCause.unknown} recopies=${ctx.recopies} verifyScans=${ctx.verifyScans || 0} cacheTrusted=${ctx.cacheTrustedHits || 0} hostsMissingWorkers=${ctx.missingFiles.size}${ctx.missingFiles.size ? ` [${[...ctx.missingFiles].slice(0, 8).join(",")}]` : ""}`);
        if (ctx.fa?.n) fileLine(`FreeAtDiag: n=${ctx.fa.n} avgGain=${(ctx.fa.sum/ctx.fa.n).toFixed(2)}GB maxGain=${ctx.fa.max.toFixed(2)}GB neg=${ctx.fa.neg} spacing=${C.SPACING}`);
        fileLine(`Spacing: pick=${ctx.drift?.pick ?? C.SPACING}`);
        for (const t of targets) {
            const st = state[t.name], sx = statOf(t.name);
            const dx = statOfDisplay(t.name);
            fileLine(`${t.name.padEnd(18)} mode=${st.mode} bad=${st.bad} pct=${st.pct} secTol=${st.secTol.toFixed(2)} money=${Math.round(t.curMoney)}/${Math.round(t.maxM)} sec=${t.curSec.toFixed(3)}/${t.minSec.toFixed(3)} wT=${(t.wT/1000).toFixed(2)}s wNow=${(t.wNow/1000).toFixed(2)}s score=${t.score.toExponential(3)} chance=${t.chance.toFixed(3)} inflight=H${sx.h}/G${sx.g}/W${sx.w} recent=H${dx.h.toFixed(0)}/G${dx.g.toFixed(0)}/W${dx.w.toFixed(0)} batches=${dx.batches.toFixed(1)} nextLandIn=${Math.round(st.nextLand-Date.now())}ms`);
        }

        // -- D7: snapshot writes are rate-limited *and* budgeted --
        // The old condition rewrote the whole (up to 1.2 MB) file on every tick that
        // produced any event, which on a many-target network is nearly every tick.
        // A 250 ms reactive cadence multiplies that by 4x, so a per-window byte
        // budget matters more than the interval: a debug log must never dominate
        // the scheduler's own I/O.
        // Snapshot cadence: push EVERY tick so `tick % SNAPSHOT_EVERY_TICKS` samples
        // N distinct ticks, then let the write throttle and byte budget decide how
        // often it actually hits disk. Pushing only on eventful ticks made the
        // modulo branch re-serialise the previous eventful tick's content, so the
        // "every 20 ticks" cadence stopped meaning a fresh window.
        historyBuffer.push({ t: tickStart, text: currentTickOutput });
        pruneLog(historyBuffer, C.LOG_RETENTION_MS, C.SNAPSHOT_MAX_BYTES);
        const snapshotDue = (tick % C.SNAPSHOT_EVERY_TICKS === 0 || tickEvents.length > 0) &&
            (tickStart - lastSnapshotWrite) >= C.SNAPSHOT_MIN_WRITE_MS;
        if (snapshotDue) {
            if (tickStart - logWindowStart >= C.LOG_WINDOW_MS) {
                logWindowStart = tickStart;
                logWindowBytes = 0;
            }
            const text = historyBuffer.map(item => item.text).join("");
            // Charge only the NEW text against the window budget.
            // The old test compared the budget against the whole cumulative buffer,
            // which is by design capped at SNAPSHOT_MAX_BYTES (1.2 MB) and so always
            // exceeds the 400 KB window: after the first write of each window every
            // subsequent write was suppressed and the log silently froze, which is
            // exactly why long runs only ever showed early snapshots.
            const previous = lastSnapshotTextLength;
            const delta = Math.max(0, text.length - previous);
            if (logWindowBytes + delta <= C.LOG_MAX_BYTES_PER_WINDOW) {
                await ns.write(C.LOG_FILE, text, "w");
                logWindowBytes += delta;
                lastSnapshotWrite = tickStart;
                lastSnapshotTextLength = text.length;
            } else if (tickStart - lastSnapshotWrite >= C.LOG_WINDOW_MS) {
                // Bypass the budget once per window so the log still advances.
                await ns.write(C.LOG_FILE, text, "w");
                logWindowBytes = delta;
                lastSnapshotWrite = tickStart;
                lastSnapshotTextLength = text.length;
                logBudgetBypass++;
            } else {
                logSuppressed++;
            }
        }

        // -- Event log throttle --
        if (eventsDirty && (tickStart - lastEventWrite) >= C.EVENT_WRITE_MS) {
            pruneLog(eventLog, C.LOG_RETENTION_MS, C.EVENT_MAX_BYTES);
            await ns.write(C.EVENT_LOG, eventLog.map(item => item.text).join(""), "w");
            eventsDirty = false;
            lastEventWrite = tickStart;
        }

        // -- B6: don't idle a released pool for a full tick --
        // The launch pass happens once per tick, so RAM that frees mid-tick waits up
        // to TICK ms. When the previous pass ended because it ran out of headroom or
        // work, come back sooner.
        const busyMs = Date.now() - tickStart;
        let waitMs = Math.max(C.MIN_SLEEP_MS, C.TICK - busyMs);
        if ((saturated || needsRefillSoon) && waitMs > C.REACTIVE_TICK_MS) {
            waitMs = C.REACTIVE_TICK_MS;
        }
        await ns.sleep(waitMs);
    }
}

// ====================================================================
// CORE LOGIC & HELPERS
// ====================================================================

const C_INCOME_WINDOW_MS = 90_000;   // trailing window the income rate is measured over
const C_INCOME_MAX_SAMPLES = 120;    // ~2 minutes of one-per-tick samples

// ====================================================================
// INCOME TRACKER
// ====================================================================
// The reported rate is derived from samples of the player's wallet, not from
// ns.getTotalScriptIncome().
//
// Why the game API is not used for the displayed rate:
//   1. It returns a *rolling window* gain for all scripts. Near a batch landing
//      the window straddles the spike and reports far too high; just after a
//      landing it straddles the trough and reports ~0. That is the "VERY high or
//      VERY low" behaviour, and it never settles because the batch cadence is ~1/s
//      while the window is ~1/s.
//   2. It is not "Cortex's own money": it includes every other script on the
//      network. An absolute tracker measures the wallet, which is the number the
//      player actually cares about matching.
//   3. It returns NaN before any income has been banked.
//
// How this tracker works:
//   - One sample per tick: {t, money, earned}. `money` is the wallet, `earned` is
//     Cortex's own lifetime hack income. Sampling at a fixed point in the loop
//     (before this tick's deploys) keeps the series evenly spaced.
//   - The rate is the MEDIAN of pairwise slopes between samples in a ~90s window
//     (a Theil-Sen style estimator). Endpoint deltas are what make a naive tracker
//     spike; the median over many pairs is robust to one or two bad samples.
//   - Discontinuities are handled explicitly: an augment install or a node reset
//     wipes or converts the wallet, so the history is dropped and the rate rebuilt
//     from scratch rather than reported as a huge negative.
function snapshotIncome(ctx, ns, tick, earned) {
    const WINDOW_MS = C_INCOME_WINDOW_MS;
    const MAX_SAMPLES = C_INCOME_MAX_SAMPLES;
    const t = Date.now();
    let money = 0;
    try { money = ns.getServerMoneyAvailable("home"); } catch { }
    if (!Number.isFinite(money)) money = 0;

    const tr = ctx.income ??= {
        samples: [],
        rate: 0,
        earnedAtStart: ctx.earned || 0,
        lastMoney: money,
        resets: 0,
    };

    // Detect wallet discontinuities that are not income.
    // A real spend (buying a server, upgrading home RAM) must not wipe the
    // history, so a drop is only treated as a discontinuity once it is both large
    // in absolute terms and far outside the wallet's recent high-water mark. An
    // augment install or node reset drops the wallet by orders of magnitude and
    // trips this immediately.
    if (tr.lastMoneyAt) {
        const delta = money - tr.lastMoney;
        const highWater = Math.max(tr.highWater || 0, tr.lastMoney);
        tr.highWater = Math.max(highWater, money);
        if (delta < 0 && highWater > 0 && money < highWater * 0.25 && highWater - money > 1e6) {
            tr.samples.length = 0;
            tr.resets++;
            ctx.augResetSeen = true;
        }
    }
    tr.lastMoney = money;
    tr.lastMoneyAt = t;

    tr.samples.push({ t, m: money, e: earned });
    if (tr.samples.length > MAX_SAMPLES) tr.samples.splice(0, tr.samples.length - MAX_SAMPLES);

    const cutoff = t - WINDOW_MS;
    const win = tr.samples.filter(s => s.t >= cutoff);
    // Both series are reduced with the same estimator over the same window. If the
    // wallet rate works, the earned rate works: identical code path, different key.
    const medianSlope = key => {
        if (win.length < 2) return 0;
        const slopes = [];
        for (let i = 0; i < win.length; i++) {
            for (let j = i + 1; j < win.length; j++) {
                const dtm = (win[j].t - win[i].t) / 1000;
                if (dtm <= 0) continue;
                const a = win[i][key], b = win[j][key];
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                const s = (b - a) / dtm;
                if (Number.isFinite(s)) slopes.push(s);
            }
        }
        if (!slopes.length) return 0;
        slopes.sort((x, y) => x - y);
        const mid = slopes.length >> 1;
        return slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
    };
    const walletRate = medianSlope("m");
    tr.rate = walletRate;
    tr.earnedRate = Math.max(0, medianSlope("e"));
    return tr.rate;
}

// Unused placeholder removed: Cortex's lifetime income now comes from
// getMoneySources().sinceStart.hack, which cannot drift out of step.


function scan(ns) {
    const seen = new Set(["home"]), q = ["home"];
    for (let i = 0; i < q.length; i++) for (const n of ns.scan(q[i])) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return q;
}

function selectTargets(ns, targets, C, formulas, maxRam, pool, R, ctx, state) {
    const slotRam = Math.max(R.h, R.g, R.w);
    for (const st of Object.values(state)) {
        const cycle = st.earlyCycle;
        if (!cycle) continue;
        cycle.pids = cycle.pids.filter(({ pid, host }) => ns.isRunning(pid, host));
        if ((cycle.phase === "SELECT" || cycle.draining) && cycle.pids.length === 0) {
            st.earlyCycle = null;
            if (st.mode === "drain") st.mode = "prep";
        }
    }
    if (formulas || maxRam >= C.EARLY_MODE_MAX_RAM_GB) {
        for (const st of Object.values(state)) {
            if (st.earlyCycle) st.earlyCycle.draining = true;
        }
        return { targets, mode: "NORMAL", plans: {}, reservations: {}, slotRam, reason: null };
    }

    const basePool = pool.map(host => ({ ...host }));
    const reservingTargets = new Set(Object.entries(state)
        .filter(([, st]) => st.earlyCycle && !st.earlyCycle.draining)
        .map(([name]) => name));
    for (const job of ctx.ledger) {
        if (!job.early || !job.host || !reservingTargets.has(job.t) ||
            !ns.isRunning(job.pid, job.host)) continue;
        const host = basePool.find(item => item.name === job.host);
        if (host) host.free += job.n * job.ram;
    }

    for (const t of targets) {
        const baseline = evaluateEarlyTarget(ns, t, C, R, basePool, slotRam, 1, 1, false);
        t.earlyScore = baseline.plan?.expectedPerSecond || 0;
    }
    const ranked = targets.slice().sort((a, b) =>
        b.earlyScore - a.earlyScore ||
        b.maxM * b.chance - a.maxM * a.chance ||
        a.name.localeCompare(b.name)
    );
    for (const t of targets) {
        state[t.name] ??= { mode: "prep", bad: 0, nextLand: 0, pct: 0, secTol: 0, earlyCycle: null };
    }

    const budgetPool = basePool.map(host => ({ ...host }));
    const active = [];
    const plans = {};
    const reservations = {};
    const existing = targets
        .filter(t => state[t.name]?.earlyCycle && !state[t.name].earlyCycle.draining)
        .sort((a, b) => b.earlyScore - a.earlyScore);
    for (const t of existing) {
        const cycle = state[t.name].earlyCycle;
        let reservation = cycle.reservation || {};
        if (!reservationFits(budgetPool, reservation, slotRam) && cycle.pids.length === 0) {
            reservation = reservePlan(budgetPool, cycle.plan.reservationSlots, slotRam);
            if (reservation) cycle.reservation = reservation;
        } else if (reservationFits(budgetPool, reservation, slotRam)) {
            consumeReservation(budgetPool, reservation, slotRam);
        } else {
            reservation = null;
        }
        if (!reservation) {
            cycle.draining = true;
            cycle.drainReason = "its reserved host slots no longer fit";
            for (const job of ctx.ledger) {
                if (!job.early || job.t !== t.name || !job.host || !ns.isRunning(job.pid, job.host)) continue;
                const host = budgetPool.find(item => item.name === job.host);
                if (host) host.free = Math.max(0, host.free - job.n * job.ram);
            }
            continue;
        }
        active.push(t);
        plans[t.name] = cycle.plan;
        reservations[t.name] = reservation;
    }

    let primary = active[0] || null;
    let primaryThreads = primary ? state[primary.name].earlyCycle.plan.threads : 1;
    const knownTargetNames = new Set(targets.map(t => t.name));
    for (const [name, st] of Object.entries(state)) {
        if (!knownTargetNames.has(name) && st.earlyCycle) st.earlyCycle.draining = true;
    }
    const newTargets = ranked.filter(t =>
        !plans[t.name] && !state[t.name]?.earlyCycle && t.earlyScore > 0
    );
    const admittedNew = [];
    const tryExpand = (target, minThreads, maxThreads, requireFullRecovery) => {
        const currentPlan = plans[target.name];
        const ownReservation = reservations[target.name];
        const expansionPool = poolWithReservation(budgetPool, ownReservation, slotRam);
        const expanded = evaluateEarlyTarget(ns, target, C, R, expansionPool, slotRam,
            minThreads, maxThreads, requireFullRecovery);
        if (!expanded.plan || expanded.plan.threads <= currentPlan.threads) return;
        const updated = replaceReservation(budgetPool, ownReservation,
            expanded.plan.reservationSlots, slotRam);
        if (!updated) return;
        plans[target.name] = expanded.plan;
        reservations[target.name] = updated;
    };

    if (!primary) {
        for (const t of newTargets) {
            const candidate = evaluateEarlyTarget(ns, t, C, R, budgetPool, slotRam, 1, 1, false);
            if (!candidate.plan) continue;
            const reservation = reservePlan(budgetPool, candidate.plan.reservationSlots, slotRam);
            if (!reservation) continue;
            primary = t;
            primaryThreads = candidate.plan.threads;
            plans[t.name] = candidate.plan;
            reservations[t.name] = reservation;
            admittedNew.push(t);
            break;
        }
    }

    if (primary) {
        for (const t of newTargets) {
            if (t.name === primary.name) continue;
            const minThreads = Math.max(
                1,
                Math.ceil(C.EARLY_SECONDARY_MIN_STEAL / Math.max(t.hackPerThread, 1e-12)),
                Math.ceil(primaryThreads * C.EARLY_SECONDARY_PRIMARY_RATIO)
            );
            const candidate = evaluateEarlyTarget(ns, t, C, R, budgetPool, slotRam,
                minThreads, minThreads, true);
            if (!candidate.plan) continue;
            const reservation = reservePlan(budgetPool, candidate.plan.reservationSlots, slotRam);
            if (!reservation) continue;
            plans[t.name] = candidate.plan;
            reservations[t.name] = reservation;
            admittedNew.push(t);
        }

        if (!active.length && admittedNew.length > 0) {
            const secondaries = admittedNew.filter(t => t.name !== primary.name);
            const maxPrimary = secondaries.length
                ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(
                    Math.min(...secondaries.map(t => plans[t.name].threads)) /
                    C.EARLY_SECONDARY_PRIMARY_RATIO
                ))
                : Number.MAX_SAFE_INTEGER;
            tryExpand(primary, 1, maxPrimary, false);
        }

        if (!active.length || admittedNew.some(t => t.name !== primary.name)) {
            primaryThreads = plans[primary.name].threads;
            for (const t of admittedNew) {
                if (t.name === primary.name) continue;
                const minThreads = Math.max(
                    1,
                    Math.ceil(C.EARLY_SECONDARY_MIN_STEAL / Math.max(t.hackPerThread, 1e-12)),
                    Math.ceil(primaryThreads * C.EARLY_SECONDARY_PRIMARY_RATIO)
                );
                tryExpand(t, minThreads, Number.MAX_SAFE_INTEGER, true);
            }
            if (!active.length) {
                const secondaries = admittedNew.filter(t => t.name !== primary.name);
                const maxPrimary = secondaries.length
                    ? Math.floor(Math.min(...secondaries.map(t => plans[t.name].threads)) /
                        C.EARLY_SECONDARY_PRIMARY_RATIO)
                    : Number.MAX_SAFE_INTEGER;
                tryExpand(primary, 1, maxPrimary, false);
            }
        }
    }

    const selected = [...active, ...admittedNew];
    return {
        targets: selected,
        mode: "EARLY",
        plans,
        reservations,
        slotRam,
        reason: selected.length
            ? `${selected.length} target(s) admitted with reserved recovery capacity`
            : (ranked.length ? "no candidate fits its minimum early-cycle reservation" : "no rooted targets meet early-mode eligibility"),
    };
}

function evaluateEarlyTarget(ns, t, C, R, pool, slotRam, minThreads = 1,
    maxThreads = Number.MAX_SAFE_INTEGER, requireFullRecovery = false) {
    const hackPct = t.hackPerThread;
    if (!(hackPct > 0) || !Number.isFinite(hackPct)) {
        return { target: t, plan: null, reason: "no positive fallback hack fraction", rank: 1 };
    }
    const hackCapacity = earlyCapacity(pool, R.h);
    const slotCapacity = earlyCapacity(pool, slotRam);
    if (hackCapacity < minThreads || slotCapacity < 1) {
        return { target: t, plan: null, reason: "not enough available RAM for one hack thread", rank: 2 };
    }
    const growCapacity = earlyCapacity(pool, R.g);
    const weakenCapacity = earlyCapacity(pool, R.w);
    if (growCapacity < 1 || weakenCapacity < 1) {
        const phase = growCapacity < 1 ? "grow" : "weaken";
        return { target: t, plan: null, reason: `not enough available RAM for one ${phase} thread`, rank: 3 };
    }

    const maxFraction = Math.min(C.MAX_HACK_FRACTION, 1 - C.EARLY_MIN_MONEY_FRACTION);
    let high = Math.min(
        Math.floor(maxFraction / hackPct + 1e-9),
        hackCapacity,
        slotCapacity,
        maxThreads
    );
    if (!Number.isSafeInteger(high)) high = Number.MAX_SAFE_INTEGER;
    if (high < minThreads) {
        return { target: t, plan: null, reason: "not enough available RAM for one hack thread within the vault floor", rank: 2 };
    }
    const growEstimate = ns.growthAnalyze(t.name, 1 / C.EARLY_MIN_MONEY_FRACTION);
    if (!(growEstimate > 0) || !Number.isFinite(growEstimate)) {
        return { target: t, plan: null, reason: "fallback growth analysis could not estimate recovery", rank: 4 };
    }
    const growThreads = Math.ceil(growEstimate * C.GROW_PAD) + C.GROW_EXTRA_THREADS;
    const weakenGrowThreads = Math.max(1, Math.ceil(growThreads * C.GROW_SEC / C.WPT));
    const candidateAt = threads => {
        const fraction = hackPct * threads;
        if (fraction > maxFraction + 1e-12 || fraction >= 1) return null;
        const weakenHackThreads = Math.max(1, Math.ceil(threads * C.HACK_SEC / C.WPT));
        // Each slot can host one thread of the largest worker; secondaries reserve
        // grow and recovery weaken together, while the primary may chunk recovery.
        const reservationSlots = requireFullRecovery
            ? growThreads + weakenGrowThreads + Math.max(threads, weakenHackThreads)
            : Math.max(
                threads,
                Math.min(weakenHackThreads, slotCapacity),
                Math.min(growThreads, slotCapacity),
                Math.min(weakenGrowThreads, slotCapacity)
            );
        if (reservationSlots > slotCapacity) return null;
        return { fraction, growThreads, weakenHackThreads, weakenGrowThreads, reservationSlots };
    };
    const minimumCandidate = candidateAt(minThreads);
    if (!minimumCandidate) {
        return {
            target: t, plan: null,
            reason: requireFullRecovery
                ? "secondary target cannot reserve a complete grow/weaken recovery envelope"
                : "minimum hack-thread candidate does not fit available RAM",
            rank: 5,
        };
    }
    let low = minThreads;
    while (low < high) {
        const mid = low + Math.ceil((high - low) / 2);
        if (candidateAt(mid)) low = mid;
        else high = mid - 1;
    }
    const feasibility = candidateAt(low);
    const cycle = estimateEarlyCycle(t, hackPct, low, growThreads,
        feasibility.weakenHackThreads, weakenGrowThreads, slotCapacity, slotCapacity, C);
    if (!cycle) {
        return { target: t, plan: null, reason: "could not estimate a complete hack-and-recovery cycle", rank: Number.MAX_SAFE_INTEGER };
    }
    const withinCycleLimit = cycle.cycleMs <= C.EARLY_MAX_CYCLE_MS;
    return {
        target: t,
        reason: withinCycleLimit
            ? null
            : `estimated cycle ${(cycle.cycleMs / 1000).toFixed(1)}s exceeds preferred ${C.EARLY_MAX_CYCLE_MS / 1000}s limit`,
        rank: 0,
        plan: {
            threads: low,
            fraction: feasibility.fraction,
            growThreads: feasibility.growThreads,
            weakenHackThreads: feasibility.weakenHackThreads,
            weakenGrowThreads: feasibility.weakenGrowThreads,
            reservationSlots: feasibility.reservationSlots,
            growActions: cycle.growActions,
            weakenHackActions: cycle.weakenHackActions,
            weakenGrowActions: cycle.weakenGrowActions,
            hackActions: cycle.hackActions,
            cycleMs: cycle.cycleMs,
            expectedMoney: cycle.expectedMoney,
            expectedPerSecond: cycle.expectedMoney / (cycle.cycleMs / 1000),
            withinCycleLimit,
        },
        reservation: null,
    };
}

function reservePlan(pool, slots, slotRam) {
    const parts = allocate(pool, slotRam, slots, false);
    if (!parts) return null;
    const reservation = {};
    for (const part of parts) reservation[part.host] = (reservation[part.host] || 0) + part.threads;
    return reservation;
}

function reservationFits(pool, reservation, slotRam) {
    return Object.entries(reservation).every(([hostName, slots]) => {
        const host = pool.find(item => item.name === hostName);
        return host && Math.floor(host.free / slotRam + 1e-9) >= slots;
    });
}

function consumeReservation(pool, reservation, slotRam) {
    for (const [hostName, slots] of Object.entries(reservation)) {
        const host = pool.find(item => item.name === hostName);
        if (host) host.free = Math.max(0, host.free - slots * slotRam);
    }
}

function poolWithReservation(pool, reservation, slotRam) {
    const result = pool.map(host => ({ ...host }));
    for (const [hostName, slots] of Object.entries(reservation)) {
        const host = result.find(item => item.name === hostName);
        if (host) host.free += slots * slotRam;
    }
    return result;
}

function replaceReservation(pool, oldReservation, newSlots, slotRam) {
    const expandedPool = poolWithReservation(pool, oldReservation, slotRam);
    const reservation = reservePlan(expandedPool, newSlots, slotRam);
    if (!reservation) return null;
    for (let i = 0; i < pool.length; i++) pool[i].free = expandedPool[i].free;
    return reservation;
}

function reservedEarlyPool(pool, reservation, slotRam) {
    return pool.map(host => ({
        ...host,
        free: Math.min(host.free, (reservation?.[host.name] || 0) * slotRam),
    }));
}

function estimateEarlyCycle(t, hackPct, maxThreads, growThreads, weakenHackThreads,
    weakenGrowThreads, growCapacity, weakenCapacity, C) {
    const floorMoney = t.maxM * C.EARLY_MIN_MONEY_FRACTION;
    let remaining = t.maxM;
    let expectedMoney = 0;
    let hackActions = 0;
    let weakenHackActions = 0;
    const attackDurationMs = t.hT + C.TICK;
    const growActions = Math.max(1, Math.ceil(growThreads / growCapacity));
    const weakenGrowActions = Math.max(1, Math.ceil(weakenGrowThreads / weakenCapacity));
    if (!(attackDurationMs > 0) || !Number.isFinite(attackDurationMs) ||
        !(t.wT > 0) || !Number.isFinite(t.wT) ||
        !(t.gT > 0) || !Number.isFinite(t.gT)) return null;

    while (remaining > floorMoney + Math.max(1, t.maxM * 1e-9)) {
        const safeFraction = Math.min(C.MAX_HACK_FRACTION, 1 - floorMoney / remaining);
        const threads = Math.min(maxThreads, Math.floor(safeFraction / hackPct + 1e-9));
        if (threads < 1) break;
        const fraction = hackPct * threads;
        const expectedStolen = remaining * fraction * t.chance;
        if (!(expectedStolen > 0) || !Number.isFinite(expectedStolen)) return null;
        remaining = Math.max(0, remaining - expectedStolen);
        expectedMoney += expectedStolen;
        hackActions++;
        weakenHackActions += Math.max(1, Math.ceil(
            Math.ceil(threads * C.HACK_SEC / C.WPT) / weakenCapacity
        ));
        if (hackActions > 10000) return null;
    }
    if (hackActions < 1) return null;
    const cycleMs = hackActions * attackDurationMs +
        (weakenHackActions + weakenGrowActions) * (t.wT + C.TICK) +
        growActions * (t.gT + C.TICK);
    if (!Number.isFinite(cycleMs) || cycleMs <= 0) return null;
    return { hackActions, growActions, weakenHackActions, weakenGrowActions, expectedMoney, cycleMs };
}

function earlyCapacity(pool, ram) {
    if (!(ram > 0) || !Number.isFinite(ram)) return 0;
    return pool.reduce((sum, host) =>
        sum + Math.floor(host.free / ram + 1e-9), 0);
}

function makePlan(ns, t, hackThreads, C, R, player, formulas) {
    const hp = t.hackPerThread;
    if (!(hp > 0) || !Number.isFinite(hp)) return null;
    const h = hackThreads;
    if (!Number.isSafeInteger(h) || h < 1) return null;
    const frac = hp * h;
    if (frac > C.MAX_HACK_FRACTION || frac >= 1) return null;
    const gt = rawGrowThreads(ns, t, frac, player, formulas);
    return makePlanFromGrowThreads(t, h, frac, gt, C, R);
}

function pctLabel(frac) {
    const pct = frac * 100;
    if (pct > 0 && pct < 0.001) return "<0.001%";
    return `${pct < 1 ? pct.toFixed(3) : pct.toFixed(0)}%`;
}

function cachedPlan(ns, t, hackThreads, C, R, player, formulas) {
    let cache = t.planCache;
    if (!(cache instanceof Map)) {
        cache = new Map();
        t.planCache = cache;
    }
    if (cache.has(hackThreads)) return cache.get(hackThreads);

    const plan = makePlan(ns, t, hackThreads, C, R, player, formulas);
    cache.set(hackThreads, plan);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return plan;
}

function makePlanFromGrowThreads(t, h, frac, gt, C, R) {
    const w1 = Math.max(1, Math.ceil(h * C.HACK_SEC / C.WPT));
    if (!(gt > 0) || !Number.isFinite(gt)) return null;
    const g = Math.ceil(gt * C.GROW_PAD) + C.GROW_EXTRA_THREADS;
    const w2 = Math.max(1, Math.ceil(g * C.GROW_SEC / C.WPT));
    const ram = h*R.h + g*R.g + (w1+w2)*R.w;
    const lead = t.wNow*1.02 + C.LEAD + 2*C.SPACING;
    const ramSec = (R.h*h*Math.max(0,lead-3*C.SPACING) + R.w*w1*Math.max(0,lead-2*C.SPACING) + R.g*g*Math.max(0,lead-C.SPACING) + R.w*w2*lead) / 1000;
    const avgRam = (ramSec * 1000) / t.wT;
    const secTol = Math.max(h*C.HACK_SEC,g*C.GROW_SEC)*1.15 + 0.05;
    return { pct: frac, frac, h, g, w1, w2, ram, ramSec, avgRam, secTol };
}

function rawGrowThreads(ns, t, frac, player, formulas) {
    if (!(frac >= 0) || frac >= 1) return NaN;
    if (formulas) {
        const minimumSecurityServer = {
            ...t.mock,
            hackDifficulty: t.minSec,
            moneyAvailable: t.maxM * (1 - frac),
        };
        return ns.formulas.hacking.growThreads(minimumSecurityServer, player, t.maxM, 1);
    }
    return ns.growthAnalyze(t.name, 1 / (1 - frac));
}

function runEarlyCycleTick(ns, pool, ctx, t, st, C, R, F) {
    const cycle = st.earlyCycle;
    cycle.pids = cycle.pids.filter(({ pid, host }) => ns.isRunning(pid, host));
    if (cycle.pids.length > 0) {
        const phase = cycle.draining ? "DRAIN" : (cycle.activePhase || cycle.phase);
        return earlyCycleResult(cycle, phase, `running ${cycle.pids.length} worker group(s)`, false, false);
    }
    cycle.activePhase = null;
    if (cycle.draining) {
        return earlyCycleResult(cycle, "DRAIN", "waiting for in-flight work to finish", false, false);
    }

    const otherWorkersRunning = ctx.ledger.some(job =>
        job.t === t.name && job.host &&
        Date.now() - (job.start || 0) < C.LEDGER_GRACE &&
        ns.isRunning(job.pid, job.host)
    );
    if (otherWorkersRunning) {
        return earlyCycleResult(cycle, "WAIT", "draining previous target workers", false, false);
    }
    if (cycle.phase === "SELECT") {
        return earlyCycleResult(cycle, "SELECT", "awaiting cycle-boundary target ranking", false, false);
    }

    const server = ns.getServer(t.name);
    const minSec = server.minDifficulty;
    const secDiff = Math.max(0, server.hackDifficulty - minSec);
    const money = server.moneyAvailable;
    const maxMoney = server.moneyMax;
    const securityReady = secDiff <= C.EARLY_SEC_EPS;
    const moneyReady = money >= maxMoney * C.EARLY_GROW_MONEY_FRACTION;
    const capacity = ram => pool.reduce((sum, host) =>
        sum + (ram > 0 ? Math.floor(host.free / ram + 1e-9) : 0), 0);

    for (let transitions = 0; transitions < 4; transitions++) {
        if (cycle.phase === "PREP") {
            if (!securityReady) {
                const needed = Math.ceil(secDiff / C.WPT);
                const threads = Math.min(needed, capacity(R.w));
                if (threads < 1) {
                    cycle.blocker = "no reserved weaken thread fits while preparing";
                    return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
                }
                const launched = launchEarlyAction(ns, pool, ctx, t.name, F.w, "w", R.w,
                    threads, ns.getWeakenTime(t.name));
                if (launched.threads < 1) {
                    cycle.blocker = "could not launch preparation weaken";
                    return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
                }
                cycle.activePhase = "PREP";
                cycle.pids = launched.pids;
                return earlyCycleResult(cycle, "PREP", `${launched.threads}/${needed} weaken threads`, true, false);
            }
            if (!moneyReady) {
                const estimate = ns.growthAnalyze(t.name, maxMoney / Math.max(money, 1));
                const needed = Number.isFinite(estimate)
                    ? Math.max(1, Math.ceil(estimate * C.GROW_PAD) + C.GROW_EXTRA_THREADS)
                    : 0;
                const threads = Math.min(needed, capacity(R.g));
                if (threads < 1) {
                    cycle.blocker = "no reserved grow thread fits while preparing";
                    return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
                }
                const launched = launchEarlyAction(ns, pool, ctx, t.name, F.g, "g", R.g,
                    threads, ns.getGrowTime(t.name));
                if (launched.threads < 1) {
                    cycle.blocker = "could not launch preparation grow";
                    return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
                }
                cycle.activePhase = "PREP";
                cycle.pids = launched.pids;
                return earlyCycleResult(cycle, "PREP", `${launched.threads}/${needed} grow threads`, true, false);
            }
            st.mode = "batch";
            cycle.phase = "HACK";
            cycle.started = false;
            continue;
        }

        if (cycle.phase === "HACK") {
            if (!cycle.started && !moneyReady) {
                st.mode = "prep";
                cycle.phase = "PREP";
                continue;
            }
            if (!securityReady) {
                cycle.phase = "WEAKEN_HACK";
                continue;
            }
            const floorMoney = maxMoney * C.EARLY_MIN_MONEY_FRACTION;
            if (money <= floorMoney + Math.max(1, maxMoney * 1e-9)) {
                cycle.phase = "GROW";
                continue;
            }
            const hackPct = ns.hackAnalyze(t.name);
            const maxSafeFraction = Math.min(
                C.MAX_HACK_FRACTION,
                Math.max(0, 1 - floorMoney / money)
            );
            const byVault = hackPct > 0 && Number.isFinite(hackPct)
                ? Math.floor(maxSafeFraction / hackPct + 1e-9) : 0;
            if (hackPct > 0 && Number.isFinite(hackPct) && byVault < 1) {
                cycle.phase = "GROW";
                continue;
            }
            const plannedThreads = cycle.plan?.threads || Number.MAX_SAFE_INTEGER;
            const threads = Math.min(byVault, capacity(R.h), plannedThreads);
            if (threads < 1) {
                cycle.blocker = hackPct > 0
                    ? `no hack thread fits while preserving ${Math.round(C.EARLY_MIN_MONEY_FRACTION * 100)}% vault`
                    : "hackAnalyze returned no positive per-thread fraction";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            const duration = ns.getHackTime(t.name);
            const launched = launchEarlyAction(ns, pool, ctx, t.name, F.h, "h", R.h, threads, duration);
            if (launched.threads < 1) {
                cycle.blocker = "no hack worker could be launched from current RAM";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            cycle.phase = "WEAKEN_HACK";
            cycle.activePhase = "HACK";
            cycle.threads = launched.threads;
            cycle.fraction = hackPct * launched.threads;
            cycle.pids = launched.pids;
            cycle.blocker = null;
            cycle.started = true;
            return earlyCycleResult(cycle, "HACK",
                `${launched.threads} threads; planned steal ${pctLabel(cycle.fraction)}`, true, false);
        }

        if (cycle.phase === "WEAKEN_HACK" || cycle.phase === "WEAKEN_GROW") {
            if (secDiff <= C.EARLY_SEC_EPS) {
                if (cycle.phase === "WEAKEN_HACK") {
                    cycle.phase = money <= maxMoney * C.EARLY_MIN_MONEY_FRACTION + Math.max(1, maxMoney * 1e-9)
                        ? "GROW" : "HACK";
                } else {
                    cycle.phase = "SELECT";
                    cycle.started = false;
                    return earlyCycleResult(cycle, "SELECT", "cycle recovered; re-ranking targets", false, false);
                }
                continue;
            }
            const needed = Math.ceil(secDiff / C.WPT);
            const threads = Math.min(needed, capacity(R.w), Number.MAX_SAFE_INTEGER);
            if (threads < 1) {
                cycle.blocker = "no weaken thread fits current free RAM";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            const duration = ns.getWeakenTime(t.name);
            const launched = launchEarlyAction(ns, pool, ctx, t.name, F.w, "w", R.w, threads, duration);
            if (launched.threads < 1) {
                cycle.blocker = "no weaken worker could be launched from current RAM";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            cycle.activePhase = cycle.phase;
            cycle.pids = launched.pids;
            cycle.blocker = null;
            return earlyCycleResult(cycle, cycle.phase, `${launched.threads}/${needed} weaken threads`, true, false);
        }

        if (cycle.phase === "GROW") {
            if (moneyReady) {
                cycle.phase = "WEAKEN_GROW";
                continue;
            }
            const multiplier = maxMoney / Math.max(money, 1);
            const estimate = ns.growthAnalyze(t.name, multiplier);
            const needed = Number.isFinite(estimate)
                ? Math.max(1, Math.ceil(estimate * C.GROW_PAD) + C.GROW_EXTRA_THREADS)
                : 0;
            const threads = Math.min(needed, capacity(R.g), Number.MAX_SAFE_INTEGER);
            if (threads < 1) {
                cycle.blocker = "no grow thread fits current free RAM";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            const duration = ns.getGrowTime(t.name);
            const launched = launchEarlyAction(ns, pool, ctx, t.name, F.g, "g", R.g, threads, duration);
            if (launched.threads < 1) {
                cycle.blocker = "no grow worker could be launched from current RAM";
                return earlyCycleResult(cycle, "WAIT", cycle.blocker, false, true);
            }
            cycle.activePhase = "GROW";
            cycle.pids = launched.pids;
            cycle.blocker = null;
            return earlyCycleResult(cycle, `${cycle.phase}`, `${launched.threads}/${needed} grow threads`, true, false);
        }
    }

    return earlyCycleResult(cycle, "WAIT", "phase transition limit reached; retrying", false, false);
}

function earlyCycleResult(cycle, phase, detail, launched, blocked) {
    return {
        phase, detail, launched, blocked,
        startedAt: launched ? Date.now() : null,
        threads: cycle.threads, fraction: cycle.fraction,
    };
}

// ====================================================================
// EARLY MODE, REWORKED: adaptive mini-HGW cycles
// ====================================================================
// Why the old design starved at low RAM: it refused to hack until the target was
// fully prepared (`secDiff <= EARLY_SEC_EPS`), and preparation competed for the
// same pool as income work. With a pool of ~200 GB, one weaken wave moves only
// ~0.1 security, so the server never became "ready" and the cycle could land
// thousands of weaken actions without ever launching a single hack.
//
// The rework drops that gate. Each partner repeatedly runs a complete
// H/W1/G/W2 group that is sized to the RAM actually available and to the vault
// floor, launched with absolute land times so the group resolves in order:
//
//     hack  -> weaken1 -> grow -> weaken2
//
// The first cycle pays out on a not-fully-prepped server (weaken1 covers the
// hack's security cost, weaken2 the grow's), and because every cycle restores the
// money it took, the target self-prepares as a side effect of earning.

// Smallest useful cycle: one hack thread plus the recovery it needs.
// Grow sizing must come from the real growth analysis; a crude log estimate
// overstates the need by an order of magnitude on small servers and makes the
// lane refuse to start at all.
function minMiniCycleRam(ns, t, C, R) {
    const h = 1;
    const w1 = Math.max(1, Math.ceil(h * C.HACK_SEC / C.WPT));
    const frac = Math.min(0.9, Math.max(1e-6, t.hackPerThread));
    let g = 0;
    const est = ns.growthAnalyze(t.name, 1 / Math.max(1e-9, 1 - frac));
    if (Number.isFinite(est) && est > 0) g = Math.ceil(est);
    if (g < 1) g = 1;
    const w2 = Math.max(1, Math.ceil(g * C.GROW_SEC / C.WPT));
    return h * R.h + g * R.g + (w1 + w2) * R.w;
}

function runEarlyMiniBatches(ns, ctx, targets, miniState, miniPool, C, R, F, statOfDisplay) {
    const freeOf = p => p.reduce((sum, host) => sum + host.free, 0);

    // 1. Drop partners that no longer exist or that we cannot use.
    for (const name of Object.keys(miniState)) {
        if (!targets.some(t => t.name === name)) delete miniState[name];
    }

    // 2. Rank candidates by estimated income per RAM-second, live state included.
    const ranked = targets.slice().sort((a, b) => b.score - a.score);
    const admitted = Object.keys(miniState).length;
    const maxPartners = Math.max(1, Math.min(C.EARLY_MINI_PARTNERS, Math.floor(freeOf(miniPool) / 32) || 1));

    for (const t of ranked) {
        if (Object.keys(miniState).length >= maxPartners) break;
        if (miniState[t.name]) continue;
        const need = minMiniCycleRam(ns, t, C, R);
        const share = freeOf(miniPool) / Math.max(1, Object.keys(miniState).length + 1);
        if (need > share + 1e-9) continue;
        miniState[t.name] = { nextLand: 0, plan: null, launched: 0, outcome: "new", blocked: false };
    }

    // 3. Let each partner run whatever cycle fits its share right now.
    let launchedTotal = 0;
    const partnerCount = Math.max(1, Object.keys(miniState).length);
    for (const name of Object.keys(miniState)) {
        const st = miniState[name];
        const t = targets.find(x => x.name === name);
        if (!t) continue;

        const partnerPool = miniPool.map(host => ({ ...host }));
        // Fair share: without this the first partner in iteration order could
        // claim the whole pool every tick and starve the others.
        const budget = freeOf(partnerPool) / partnerCount;
        const now = Date.now();
        const lead = t.wNow * 1.02 + C.LEAD + 2 * C.SPACING;
        const land = Math.max(st.nextLand, now + lead);

        const built = buildMiniCycle(ns, t, partnerPool, budget, land, C, R, F);
        st.plan = built.plan;
        st.phase = built.plan && built.plan.phase ? built.plan.phase : (built.jobs ? "CYCLE" : "WAIT");
        st.outcome = built.reason || "launched";

        if (!built.jobs) {
            st.blocked = true;
            continue;
        }
        st.blocked = false;

        const entries = [];
        let failed = false;
        for (const job of built.jobs) {
            const pid = run(ns, ctx, job.host, job.script, job.threads, name, job.land, job.dur);
            if (!pid) { failed = true; break; }
            entries.push({
                pid, host: job.host, start: now, end: job.land + 50,
                t: name, type: job.type, n: job.threads, b: 0, ram: job.ram,
            });
        }
        if (failed) {
            for (const e of entries) ns.kill(e.pid);
            st.blocked = true;
            st.outcome = "launch failed; RAM was taken mid-cycle";
            continue;
        }
        const hackEntry = entries.find(e => e.type === "h");
        if (hackEntry) hackEntry.b = 1;
        for (const e of entries) ctx.ledger.push(e);

        // Charge the parent pool so other partners see the reduced headroom.
        for (const job of built.jobs) {
            const host = miniPool.find(h => h.name === job.host);
            if (host) host.free = Math.max(0, host.free - job.threads * job.ram);
        }
        st.nextLand = land + 4 * C.SPACING;
        st.launched++;
        launchedTotal++;
    }

    return launchedTotal;
}

// Build one complete cycle that fits `budgetGB` of `pool`. Returns the jobs with
// resolved host/thread placements, or a reason the cycle could not be built.
function buildMiniCycle(ns, t, pool, budgetGB, land, C, R, F) {
    const server = ns.getServer(t.name);
    const maxMoney = server.moneyMax;
    const money = server.moneyAvailable;
    const minSec = server.minDifficulty;
    const secDiff = Math.max(0, server.hackDifficulty - minSec);
    const hackPct = ns.hackAnalyze(t.name);
    if (!(hackPct > 0) || !Number.isFinite(hackPct)) {
        return { jobs: null, reason: "hackAnalyze returned no usable fraction" };
    }

    // Vault floor: never drop the server below this share of its max money.
    const vaultFloor = maxMoney * C.EARLY_MIN_MONEY_FRACTION;

    // -- GROW phase --
    // A fresh server starts far below the vault floor (a 25%-full server is below
    // a 50% floor), so there is nothing legal to steal yet. The old early mode
    // answered this with a full-prep gate it could never satisfy at low RAM; the
    // rework instead grows toward the floor in budget-sized steps, carrying its own
    // security recovery, until there is money worth farming.
    if (money < vaultFloor) {
        const multiplier = vaultFloor / Math.max(1, money);
        const est = ns.growthAnalyze(t.name, multiplier);
        let want = Number.isFinite(est) && est > 0
            ? Math.max(1, Math.ceil(est * C.GROW_PAD) + C.GROW_EXTRA_THREADS) : 1;
        // Security the grow will add, and the weaken needed to undo it.
        let g = want;
        let w = Math.max(1, Math.ceil(g * C.GROW_SEC / C.WPT));
        const ramFor = () => g * R.g + w * R.w;
        // Shrink the step (never below one thread) until it fits the budget.
        while (g > 1 && ramFor() > budgetGB + 1e-9) {
            const over = ramFor() / budgetGB;
            g = Math.max(1, Math.floor(g / over));
            w = Math.max(1, Math.ceil(g * C.GROW_SEC / C.WPT));
        }
        if (ramFor() > budgetGB + 1e-9) {
            return { jobs: null, reason: `grow step needs ${ramFor().toFixed(1)}GB, budget is ${budgetGB.toFixed(1)}GB` };
        }
        const gT = ns.getGrowTime(t.name);
        const wT = ns.getWeakenTime(t.name);
        const jobs = [];
        if (!place(pool, jobs, "g", F.g, R.g, g, land - C.SPACING, gT)) {
            return { jobs: null, reason: "grow threads did not fit any host" };
        }
        if (!place(pool, jobs, "w", F.w, R.w, w, land, wT)) {
            return { jobs: null, reason: "recovery weaken did not fit any host" };
        }
        return {
            jobs,
            plan: { h: 0, g, w1: 0, w2: w, ram: ramFor(), frac: 0, phase: "GROW" },
            reason: null,
        };
    }

    const spendable = money - vaultFloor;
    if (spendable <= 0) {
        return { jobs: null, reason: `vault at floor (${(money / maxMoney * 100).toFixed(0)}% of max); waiting for grow` };
    }
    // Expected steal per thread is hackPct * chance, not hackPct: sizing on
    // hackPct alone over-hacks and can push the server below the vault floor.
    const chance = Math.max(1e-6, ns.hackAnalyzeChance(t.name));
    const stealPerThread = Math.max(1e-12, hackPct * chance);
    const maxByVault = Math.floor(spendable / (money * stealPerThread));
    const maxFractionThreads = Math.floor(C.MAX_HACK_FRACTION / hackPct);
    const formulasOn = ns.fileExists("Formulas.exe", "home");
    const playerNow = ns.getPlayer();
    let h = Math.min(maxByVault, maxFractionThreads, Math.floor(budgetGB / R.h));
    if (h < 1) h = 0;

    // Shrink h until the full cycle (hack + recovery) fits the budget.
    let plan = null;
    for (; h >= 1; h--) {
        const frac = hackPct * h;
        if (frac >= 1 || frac > C.MAX_HACK_FRACTION) continue;
        const g = Math.max(1, rawGrowThreads(ns, t, frac, playerNow, formulasOn));
        if (!Number.isFinite(g) || g < 1) continue;
        const gPadded = Math.ceil(g * C.GROW_PAD) + C.GROW_EXTRA_THREADS;
        // Weaken threads the grow itself requires. This is not optional: skipping
        // it would push security up every cycle and make the target worse.
        const w2 = Math.max(1, Math.ceil(gPadded * C.GROW_SEC / C.WPT));
        const minW1 = Math.max(1, Math.ceil(h * C.HACK_SEC / C.WPT));
        const ramNoW1 = h * R.h + gPadded * R.g + (minW1 + w2) * R.w;
        if (ramNoW1 > budgetGB + 1e-9) continue;

        // Security recovery is a *budget*, not a target.
        // Sizing w1 to clear the whole deficit in one cycle demands thousands of
        // threads on a cold server, which never fits a small pool, so the lane
        // used to give up forever. Spend what the cycle can afford instead and let
        // the deficit be paid down gradually across cycles; the grow's own weaken
        // is still fully covered, so security never runs away.
        let w1 = minW1;
        if (secDiff > C.EARLY_SEC_EPS) {
            let affordable = Math.max(minW1, Math.floor(((budgetGB - ramNoW1) / R.w) * C.EARLY_SEC_SHARE));
            const wantThreads = Math.ceil((secDiff + h * C.HACK_SEC) / C.WPT);
            w1 = Math.max(minW1, Math.min(affordable, wantThreads));
        }
        let ram = h * R.h + gPadded * R.g + (w1 + w2) * R.w;
        while (ram > budgetGB + 1e-9 && w1 > minW1) {
            w1--;
            ram = h * R.h + gPadded * R.g + (w1 + w2) * R.w;
        }
        if (ram > budgetGB + 1e-9) continue;
        plan = { h, g: gPadded, w1, w2, ram, frac, secDiff, phase: "FARM" };
        break;
    }
    if (!plan) {
        const need = minMiniCycleRam(ns, t, C, R);
        return {
            jobs: null,
            reason: `smallest cycle needs ${need.toFixed(1)}GB, budget is ${budgetGB.toFixed(1)}GB`,
        };
    }

    const hT = ns.getHackTime(t.name);
    const wT = ns.getWeakenTime(t.name);
    const gT = ns.getGrowTime(t.name);
    const jobs = [];
    // Landing order is what makes a cycle valid: hack, then the two weakens
    // around the grow. SPACING keeps the resolves from arriving in one game tick.
    if (!place(pool, jobs, "h", F.h, R.h, plan.h, land - 3 * C.SPACING, hT)) {
        return { jobs: null, reason: "hack threads did not fit any host" };
    }
    if (!place(pool, jobs, "w", F.w, R.w, plan.w1, land - 2 * C.SPACING, wT)) {
        return { jobs: null, reason: "weaken-1 threads did not fit any host" };
    }
    if (!place(pool, jobs, "g", F.g, R.g, plan.g, land - C.SPACING, gT)) {
        return { jobs: null, reason: "grow threads did not fit any host" };
    }
    if (!place(pool, jobs, "w", F.w, R.w, plan.w2, land, wT)) {
        return { jobs: null, reason: "weaken-2 threads did not fit any host" };
    }
    return { jobs, plan, reason: null };
}
// Place `threads` of one action across the pool, appending to `jobs`.
// Multi-host placement is essential on tiny networks, where no single host holds
// enough RAM for a whole cycle.
function place(pool, jobs, type, script, ramPer, threads, land, dur) {
    if (!(threads > 0)) return true;
    const parts = allocate(pool, ramPer, Math.ceil(threads), true);
    let placed = 0;
    for (const part of parts) placed += part.threads;
    if (placed < Math.ceil(threads)) {
        // Put back what we took so the pool is unchanged for the next attempt.
        for (const part of parts) {
            const host = pool.find(h => h.name === part.host);
            if (host) host.free += part.threads * ramPer;
        }
        return false;
    }
    for (const part of parts) {
        jobs.push({ type, script, host: part.host, threads: part.threads, land, dur, ram: ramPer });
    }
    return true;
}

function launchEarlyAction(ns, pool, ctx, target, script, type, ram, threads, duration) {
    const allocations = allocate(pool, ram, Math.ceil(threads), true);
    const pids = [];
    let launchedThreads = 0;
    for (const part of allocations) {
        const launchTime = Date.now();
        const pid = run(ns, ctx, part.host, script, part.threads, target, 0, duration, ram);
        const host = pool.find(item => item.name === part.host);
        if (!pid) {
            if (host) host.free += part.threads * ram;
            continue;
        }
        launchedThreads += part.threads;
        pids.push({ pid, host: part.host });
        ctx.ledger.push({
            pid, host: part.host, start: launchTime, end: launchTime + duration, t: target,
            type, n: part.threads, b: 0, ram, early: true,
        });
    }
    return { threads: launchedThreads, pids };
}

function findBestPlan(ns, t, C, R, player, formulas, F, pool, availableGB, land, diagnostic) {
    if (!(availableGB > 0) || !(R.h > 0) || !(t.hackPerThread > 0) ||
        !Number.isFinite(t.hackPerThread) || !(C.WPT > 0)) {
        diagnostic.reason = "Invalid or exhausted batch headroom.";
        return null;
    }

    let maxHackThreads = Math.min(
        Math.floor(C.MAX_HACK_FRACTION / t.hackPerThread),
        Math.floor(availableGB / R.h)
    );
    while (maxHackThreads > 0 && t.hackPerThread * maxHackThreads > C.MAX_HACK_FRACTION) {
        maxHackThreads--;
    }
    if (maxHackThreads < 1) {
        diagnostic.reason = "No hack-thread candidate is within the hack cap and available RAM.";
        return null;
    }

    const planAt = hackThreads => cachedPlan(ns, t, hackThreads, C, R, player, formulas);
    const firstPlan = planAt(1);
    if (!firstPlan) {
        diagnostic.reason = "Could not calculate a valid one-hack-thread batch.";
        return null;
    }
    if (firstPlan.ram > availableGB + 1e-9) {
        diagnostic.reason = `One-hack-thread batch needs ${firstPlan.ram.toFixed(2)}GB; only ${availableGB.toFixed(2)}GB is available.`;
        return null;
    }

    let low = 1, high = maxHackThreads;
    while (low < high) {
        const mid = low + Math.ceil((high - low) / 2);
        const plan = planAt(mid);
        if (plan && plan.ram <= availableGB + 1e-9) low = mid;
        else high = mid - 1;
    }
    const feasibleMax = low;
    let best = null;
    const scoreScale = t.maxM * t.chance;
    const evaluate = (hackThreads, plan) => {
        if (!plan || plan.ram > availableGB + 1e-9 || !(plan.ramSec > 0)) return;
        const value = plan.frac * scoreScale / plan.ramSec;
        const tieTolerance = best ? best.plan.value * 1e-12 : 0;
        if (best && value < best.plan.value - tieTolerance) return;
        const jobs = makeBatchJobs(plan, t, C, R, F, land);
        const placement = planBatchPlacement(pool, jobs);
        if (!placement.placements) {
            const failure = placement.failure;
            if (!diagnostic.lastRejectedPlan || value > diagnostic.lastRejectedPlan.value) {
                diagnostic.lastRejectedPlan = { plan, value };
            }
            if (!diagnostic.lastPlacementFailure ||
                failure.jobsPlaced > diagnostic.lastPlacementFailure.jobsPlaced) {
                diagnostic.lastPlacementFailure = failure;
            }
            return;
        }
        const scoredPlan = { ...plan, value };
        if (!best || value > best.plan.value + tieTolerance ||
            (Math.abs(value - best.plan.value) <= tieTolerance && plan.frac > best.plan.frac)) {
            best = { plan: scoredPlan, placements: placement.placements };
        }
    };

    // Within fixed grow and weaken thread counts, money/RAM-second increases with hack threads.
    // Check each plateau's endpoint first; scan backward only if its endpoint cannot be placed.
    for (let start = 1; start <= feasibleMax;) {
        const startPlan = planAt(start);
        if (!startPlan) break;

        let end = Math.min(
            feasibleMax,
            Math.floor(startPlan.w1 * C.WPT / C.HACK_SEC + 1e-9)
        );
        while (end > start &&
            Math.max(1, Math.ceil(end * C.HACK_SEC / C.WPT)) !== startPlan.w1) {
            end--;
        }
        while (end < feasibleMax &&
            Math.max(1, Math.ceil((end + 1) * C.HACK_SEC / C.WPT)) === startPlan.w1) {
            end++;
        }

        if (planAt(end).g !== startPlan.g) {
            let sameGrowLow = start, sameGrowHigh = end;
            while (sameGrowLow < sameGrowHigh) {
                const mid = sameGrowLow + Math.ceil((sameGrowHigh - sameGrowLow) / 2);
                if (planAt(mid).g === startPlan.g) sameGrowLow = mid;
                else sameGrowHigh = mid - 1;
            }
            end = sameGrowLow;
        }

        const endPlan = planAt(end);
        const potentialValue = endPlan.frac * scoreScale / endPlan.ramSec;
        const tieTolerance = best ? best.plan.value * 1e-12 : 0;
        if (!best || potentialValue >= best.plan.value - tieTolerance) {
            for (let hackThreads = end; hackThreads >= start; hackThreads--) {
                const plan = hackThreads === end ? endPlan : planAt(hackThreads);
                const value = plan.frac * scoreScale / plan.ramSec;
                const currentTolerance = best ? best.plan.value * 1e-12 : 0;
                if (best && value < best.plan.value - currentTolerance) break;
                const before = best;
                evaluate(hackThreads, plan);
                if (best !== before) break;
            }
        }
        start = end + 1;
    }
    if (!best) {
        diagnostic.reason = diagnostic.lastPlacementFailure
            ? "Aggregate RAM can fit candidates, but no complete host placement succeeded."
            : "No valid candidate plan was found.";
    }
    return best;
}

function makeBatchJobs(plan, t, C, R, F, land) {
    return [
        { type: "h", s: F.h, n: plan.h, ram: R.h, land: land - 3 * C.SPACING, dur: t.hT },
        { type: "w", s: F.w, n: plan.w1, ram: R.w, land: land - 2 * C.SPACING, dur: t.wT },
        { type: "g", s: F.g, n: plan.g, ram: R.g, land: land - C.SPACING, dur: t.gT },
        { type: "w", s: F.w, n: plan.w2, ram: R.w, land, dur: t.wT },
    ];
}

function planBatchPlacement(pool, jobs) {
    const largestFirst = jobs.slice().sort((a, b) => b.ram * b.n - a.ram * a.n);
    const sameRam = largestFirst.every(job => Math.abs(job.ram - largestFirst[0].ram) < 1e-9);
    const orders = sameRam ? [largestFirst] : permutations(largestFirst);
    let bestFailure = null;
    for (const order of orders) {
        const shadow = pool.map(host => ({ ...host }));
        const placements = [];
        let jobsPlaced = 0;
        for (const job of order) {
            const availableThreads = shadow.reduce((sum, host) => sum + Math.floor(host.free / job.ram + 1e-9), 0);
            const parts = allocate(shadow, job.ram, job.n, false);
            if (!parts) {
                const failure = {
                    type: job.type,
                    requiredThreads: job.n,
                    availableThreads,
                    jobsPlaced,
                    jobCount: jobs.length,
                };
                if (!bestFailure || failure.jobsPlaced > bestFailure.jobsPlaced ||
                    (failure.jobsPlaced === bestFailure.jobsPlaced &&
                    failure.availableThreads > bestFailure.availableThreads)) {
                    bestFailure = failure;
                }
                break;
            }
            for (const part of parts) placements.push({ host: part.host, job, threads: part.threads });
            jobsPlaced++;
        }
        if (jobsPlaced === jobs.length) return { placements, failure: null };
    }
    return { placements: null, failure: bestFailure };
}

function permutations(items) {
    const result = [];
    const build = (prefix, remaining) => {
        if (remaining.length === 0) {
            result.push(prefix);
            return;
        }
        for (let i = 0; i < remaining.length; i++) {
            build(prefix.concat(remaining[i]), remaining.slice(0, i).concat(remaining.slice(i + 1)));
        }
    };
    build([], items);
    return result;
}

function allocate(pool, ram, n, allowPartial) {
    const snapshot = pool.map(host => host.free);
    const fits = (p) => Math.floor(p.free / ram + 1e-9);
    let best = null, bestKey = Infinity;
    for (const p of pool) {
        if (fits(p) >= n) {
            const key = (p.home ? 1e15 : 0) + p.free;
            if (key < bestKey) { bestKey = key; best = p; }
        }
    }
    if (best) {
        best.free -= n * ram;
        return [{ host: best.name, threads: n }];
    }
    const order = pool.slice().sort((a, b) => (a.home - b.home) || (b.free - a.free));
    const parts = [];
    let left = n;
    for (const p of order) {
        if (left <= 0) break;
        const cap = fits(p);
        if (cap <= 0) continue;
        const take = Math.min(cap, left);
        p.free -= take * ram;
        parts.push({ host: p.name, threads: take });
        left -= take;
    }
    if (left > 0 && !allowPartial) {
        pool.forEach((host, index) => { host.free = snapshot[index]; });
        return null;
    }
    return parts;
}

// Classify an exec failure instead of lumping every 0 return into one counter.
// The three realistic causes need completely different fixes:
//   nofile    - the worker script is not on that host (augment install wipes them,
//               or an scp failed and was never retried)
//   noram     - the host genuinely cannot hold the threads (a stale free-RAM
//               reading, or another script grew into the pool)
//   nogone    - the host vanished / lost root since the pool was built
// ns.exec returns 0 for all of them, so each cause is probed only on failure;
// the happy path stays a single call.
function classifyExecFailure(ns, host, script, threads, ram) {
    try {
        if (host !== "home" && !ns.hasRootAccess(host)) return "nogone";
        if (!ns.fileExists(script, host)) return "nofile";
        if (ns.getServerMaxRam(host) <= 0) return "nogone";
        const need = ram * threads;
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (free + 1e-9 < need) return "noram";
    } catch {
        return "nogone";
    }
    return "unknown";
}

function run(ns, ctx, host, script, threads, target, land, dur, ram) {
    const pid = ns.exec(script, host, threads, target, Math.round(land), Math.round(dur), ++ctx.uid);
    ctx.execs++;
    if (pid === 0) {
        ctx.fails++;
        const cause = classifyExecFailure(ns, host, script, threads, ram || 0);
        ctx.failByCause[cause] = (ctx.failByCause[cause] || 0) + 1;
        // Remember which hosts are missing workers so the pool loop can repair
        // them instead of re-attempting the same doomed placement every tick.
        if (cause === "nofile") ctx.missingFiles.add(host);
    }
    return pid;
}

function launchBatch(ns, pool, ctx, target, placements) {
    if (!placements) return false;
    const snap = pool.map(p => p.free);
    for (const placement of placements) {
        const host = pool.find(p => p.name === placement.host);
        if (!host || placement.threads > Math.floor(host.free / placement.job.ram + 1e-9)) {
            pool.forEach((p, i) => { p.free = snap[i]; });
            return false;
        }
        host.free -= placement.threads * placement.job.ram;
    }
    const entries = [];
    for (const a of placements) {
        const pid = run(ns, ctx, a.host, a.job.s, a.threads, target, a.job.land, a.job.dur, a.job.ram);
        if (!pid) {
            for (const e of entries) ns.kill(e.pid);
            pool.forEach((p, i) => { p.free = snap[i]; });
            return false;
        }
        // B3: `end` is an expected-landing stamp only; liveness decides release,
        // and `start` lets the reconcile pass ignore just-launched jobs.
        entries.push({ pid, host: a.host, start: Date.now(), end: a.job.land + 50, t: target, type: a.job.type, n: a.threads, b: 0, ram: a.job.ram, batch: true });
    }
    const first = entries.find(e => e.type === 'h');
    if (first) first.b = 1;
    for (const e of entries) ctx.ledger.push(e);
    return true;
}

function prepDeploy(ns, pool, ctx, script, ram, threads, target, dur) {
    if (!Number.isFinite(threads) || threads <= 0) return 0;
    let done = 0;
    for (const p of allocate(pool, ram, Math.ceil(threads), true)) {
        const actionDuration = script === "w2.js"
            ? ns.getWeakenTime(target)
            : ns.getGrowTime(target);
        const launchTime = Date.now();
        const pid = run(ns, ctx, p.host, script, p.threads, target, 0, actionDuration, ram);
        if (pid) {
            done += p.threads;
            ctx.ledger.push({
                pid, host: p.host, start: launchTime, end: launchTime + actionDuration, t: target,
                type: script === "w2.js" ? "w" : "g", n: p.threads, b: 0, ram,
            });
        } else {
            const host = pool.find(item => item.name === p.host);
            if (host) host.free += p.threads * ram;
        }
    }
    return done;
}

function pickXpTarget(ns, servers, player, excluded = new Set()) {
    let best = null, bestV = 0;
    const purchased = new Set(ns.cloud.getServerNames());
    for (const s of servers) {
        if (s === "home" || purchased.has(s) || excluded.has(s) || !ns.hasRootAccess(s)) continue;
        const sv = ns.getServer(s);
        if (sv.requiredHackingSkill > player.skills.hacking) continue;
        sv.hackDifficulty = sv.minDifficulty;
        const v = ns.formulas.hacking.hackExp(sv, player) / ns.formulas.hacking.weakenTime(sv, player);
        if (v > bestV) { bestV = v; best = s; }
    }
    return best;
}

function pruneLog(buffer, retentionMs, maxBytes) {
    const cutoff = Date.now() - retentionMs;
    while (buffer.length > 0 && buffer[0].t < cutoff) buffer.shift();
    let bytes = buffer.reduce((sum, item) => sum + item.text.length, 0);
    while (buffer.length > 1 && bytes > maxBytes) bytes -= buffer.shift().text.length;
}

function spacingSample(ctx, C, err, event) {
    const d = ctx.drift ??= { n: 0, sum: 0, max: 0, pick: C.SPACING };
    d.n++; d.sum += err; d.max = Math.max(d.max, err);
    if (d.n < 500) return;
    const avg = d.sum / d.n;
    if (avg < 15 && d.max < 60) d.pick = Math.max(C.SPACING_MIN, d.pick - 5);
    else if (avg > 50) d.pick = Math.min(C.SPACING_MAX, d.pick + 5);
    event(`SPACING: avg ${avg.toFixed(1)}ms max ${d.max.toFixed(0)}ms -> pick ${d.pick}ms (${C.ADAPTIVE_SPACING ? "applied" : "log only"})`);
    if (C.ADAPTIVE_SPACING) C.SPACING = d.pick;
    d.n = 0; d.sum = 0; d.max = 0;
}

function dur(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}
