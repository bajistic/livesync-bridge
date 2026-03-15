import { defaultLoggerEnv } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_DEBUG } from "./lib/src/common/logger.ts";
import { Hub } from "./Hub.ts";
import { Config } from "./types.ts";
import { parseArgs } from "jsr:@std/cli";

const KEY = "LSB_"
defaultLoggerEnv.minLogLevel = LOG_LEVEL_DEBUG;
const configFile = Deno.env.get(`${KEY}CONFIG`) || "./dat/config.json";

console.log("LiveSync Bridge is now starting...");
let config: Config = { peers: [] };
const flags = parseArgs(Deno.args, {
    boolean: ["reset"],
    // string: ["version"],
    default: { reset: false },
});
if (flags.reset) {
    localStorage.clear();
}
try {
    const confText = await Deno.readTextFile(configFile);
    config = JSON.parse(confText);
} catch (ex) {
    console.error("Could not parse configuration!");
    console.error(ex);
}
console.log("LiveSync Bridge is now started!");

async function runBridge() {
    while (true) {
        try {
            const hub = new Hub(config);
            await hub.start();
            break;
        } catch (ex) {
            console.error("LiveSync Bridge crashed during startup/runtime loop:");
            console.error(ex);
            console.error("Retrying in 5 seconds...");
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled promise rejection in LiveSync Bridge:");
    console.error(event.reason);
    event.preventDefault();
});

addEventListener("error", (event) => {
    console.error("Unhandled error in LiveSync Bridge:");
    console.error(event.error ?? event.message);
});

await runBridge();