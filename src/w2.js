/** @param {NS} ns */

//w2.js

export async function main(ns) {

    const [target, land, dur] = ns.args;

    await ns.sleep(Math.max(0, land - dur - Date.now()));

    await ns.weaken(target);

}
