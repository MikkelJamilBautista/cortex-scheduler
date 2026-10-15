/** @param {NS} ns */

export async function main(ns) {
    const [target, rawLand] = ns.args;
    const land = Number(rawLand);
    if (typeof target !== "string" || !Number.isFinite(land)) throw new Error("Invalid g2.js arguments");

    const ms = ns.getGrowTime(target);
    await ns.grow(target, { additionalMsec: Math.max(0, Math.ceil(land - Date.now() - ms)) });

    if (land > 0 && Date.now() - land > 20) ns.tryWritePort(7, 1);
    if (land > 0) ns.writePort(8, Math.abs(Date.now() - land));
}
