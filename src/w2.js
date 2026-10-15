/** @param {NS} ns */

export async function main(ns) {
    const [target, rawLand, dur] = ns.args;
    const land = Number(rawLand);
    await ns.sleep(Math.max(0, land - dur - Date.now()));
    await ns.weaken(target);
    if (land > 0) ns.writePort(8, Math.abs(Date.now() - land));
}
