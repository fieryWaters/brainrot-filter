// Background service worker — handles config fetching on behalf of content scripts.
//
// Priority order for config:
//   1. Native app (Swift settings via App Group UserDefaults)
//   2. Scoring server /config endpoint (fallback during local dev)
//   3. Passthrough defaults (server unreachable)

const APP_BUNDLE_ID = "com.brainrotfilter.app"; // must match Xcode bundle ID
const CONFIG_TTL_MS = 30_000;

let configCache = null;
let configCacheTime = 0;

async function fetchFromNative() {
    return new Promise((resolve, reject) => {
        browser.runtime.sendNativeMessage(APP_BUNDLE_ID, { type: "getConfig" }, (response) => {
            if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

async function fetchFromServer(serverUrl) {
    const res = await fetch(`${serverUrl}/config`, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    return res.json();
}

async function resolveConfig(serverUrl) {
    const now = Date.now();
    if (configCache && now - configCacheTime < CONFIG_TTL_MS) {
        return configCache;
    }

    // Try native app (Swift) — works when installed as Safari extension
    try {
        configCache = await fetchFromNative();
        configCacheTime = now;
        return configCache;
    } catch (_) {
        // App not installed or running in Chrome during dev — fall through
    }

    // Fall back to the scoring server
    try {
        configCache = await fetchFromServer(serverUrl);
        configCacheTime = now;
        return configCache;
    } catch (_) {
        // Server also unreachable — passthrough (don't block anything)
        return { threshold: 999, action: "blur", allowOverride: true };
    }
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "getConfig") {
        const serverUrl = message.serverUrl || "http://localhost:8787";
        resolveConfig(serverUrl)
            .then(sendResponse)
            .catch(() => sendResponse({ threshold: 999, action: "blur", allowOverride: true }));
        return true; // keep message channel open for async response
    }

    if (message.type === "invalidateConfig") {
        configCache = null;
        configCacheTime = 0;
        sendResponse({ ok: true });
    }
});
