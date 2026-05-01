// ==UserScript==
// @name         Brainrot Filter POC
// @namespace    brainrot-filter
// @version      0.10.0
// @description  Score YouTube videos for brainrot using their captions.
// @match        *://*.youtube.com/*
// @run-at       document-idle
// @grant        GM.xmlHttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    "use strict";

    const SERVER = "http://localhost:8787";
    const BADGE_ID = "brainrot-score-badge";
    const STATUS_ID = "brainrot-status-badge";
    let lastVideoId = null;

    const style = document.createElement("style");
    style.textContent = `
        #${STATUS_ID}{position:absolute;top:12px;left:12px;padding:4px 8px;background:rgba(0,0,0,.75);color:#fff;font:500 11px -apple-system,sans-serif;border-radius:4px;z-index:60;pointer-events:none}
        #${BADGE_ID}{position:absolute;top:12px;right:12px;min-width:54px;height:54px;padding:0 10px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.75);color:#fff;font:700 22px -apple-system,sans-serif;border-radius:8px;z-index:60;pointer-events:none;line-height:1}
        #${BADGE_ID} .lbl{font:500 9px -apple-system,sans-serif;opacity:.7;margin-top:2px}
    `;
    document.head.appendChild(style);

    function serverRequest(path, payload, timeout = 30000) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "POST",
                url: `${SERVER}${path}`,
                data: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
                timeout,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) return reject(new Error(`server ${res.status}`));
                    resolve(JSON.parse(res.responseText));
                },
                onerror: (e) => reject(new Error(e?.error || "network error")),
                ontimeout: () => reject(new Error("timeout")),
            });
        });
    }

    function remoteLog(msg) {
        serverRequest("/log", { msg, videoId: getVideoId(), t: Date.now() }, 5000).catch(() => {});
    }

    function log(...args) {
        const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        console.log("[brainrot]", msg);
        remoteLog(msg);
    }

    function getVideoId() {
        const u = new URL(location.href);
        if (u.pathname === "/watch") return u.searchParams.get("v");
        return null;
    }

    function getVideoDetailsFromDOM() {
        const titleEl = document.querySelector("ytd-watch-metadata h1 yt-formatted-string");
        const authorEl = document.querySelector("ytd-video-owner-renderer ytd-channel-name a");
        return {
            videoId: getVideoId(),
            title: titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, ""),
            author: authorEl?.textContent?.trim() || "",
        };
    }

    function setStatus(text, color) {
        const player = document.querySelector(".html5-video-player");
        let el = document.getElementById(STATUS_ID);
        if (!el) {
            el = document.createElement("div");
            el.id = STATUS_ID;
            player.appendChild(el);
        }
        el.textContent = `brainrot: ${text}`;
        el.style.borderLeft = `3px solid ${color || "#888"}`;
    }

    function showScore(score) {
        const player = document.querySelector(".html5-video-player");
        let el = document.getElementById(BADGE_ID);
        if (!el) {
            el = document.createElement("div");
            el.id = BADGE_ID;
            player.appendChild(el);
        }
        const hue = Math.round(120 - (score / 100) * 120);
        el.style.borderBottom = `3px solid hsl(${hue}, 80%, 50%)`;
        el.innerHTML = `<div>${score}</div><div class="lbl">BRAINROT</div>`;
    }

    function clearOverlays() {
        document.getElementById(BADGE_ID)?.remove();
        document.getElementById(STATUS_ID)?.remove();
    }

    function getPageContext() {
        return new Promise((resolve) => {
            const onMsg = (e) => {
                if (e.data?.__brainrot !== true) return;
                window.removeEventListener("message", onMsg);
                resolve(e.data.payload);
            };
            window.addEventListener("message", onMsg);
            const s = document.createElement("script");
            s.textContent = `(function(){
                const payload = {
                    apiKey: ytcfg.get("INNERTUBE_API_KEY"),
                    clientVersion: ytcfg.get("INNERTUBE_CLIENT_VERSION"),
                    hl: ytcfg.get("HL"),
                };
                window.postMessage({ __brainrot: true, payload }, "*");
            })();`;
            document.documentElement.appendChild(s);
            s.remove();
        });
    }

    function parseTimedTextXml(xml) {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const decode = (s) => {
            const t = document.createElement("textarea");
            t.innerHTML = s;
            return t.value;
        };
        const out = [];
        for (const el of doc.getElementsByTagName("text")) {
            const text = decode(el.textContent).trim();
            if (text) out.push({ text });
        }
        return out;
    }

    async function fetchTranscriptInBrowser(details) {
        setStatus("reading page context...", "#64b5f6");
        const ctx = await getPageContext();
        log("page context:", JSON.stringify({ hasApiKey: !!ctx.apiKey, clientVersion: ctx.clientVersion }));

        setStatus("probing /player...", "#64b5f6");
        const playerData = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(ctx.apiKey)}&prettyPrint=false`, {
            method: "POST",
            credentials: "omit",
            headers: {
                "Content-Type": "application/json",
                "X-YouTube-Client-Name": "3",
                "X-YouTube-Client-Version": "20.10.38",
            },
            body: JSON.stringify({
                context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: ctx.hl } },
                videoId: details.videoId,
            }),
        }).then(r => r.json());

        const tracks = playerData.captions.playerCaptionsTracklistRenderer.captionTracks;
        log("caption tracks:", tracks.length, tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(","));
        const pick = tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
        const baseUrl = pick.baseUrl.replace("&fmt=srv3", "");

        setStatus("fetching timedtext...", "#64b5f6");
        const xml = await fetch(baseUrl, { credentials: "omit" }).then(r => r.text());
        log("timedtext len:", xml.length);
        const captions = parseTimedTextXml(xml);
        log("parsed segments:", captions.length);

        setStatus("scoring...", "#64b5f6");
        return await serverRequest("/ingest", {
            videoId: details.videoId,
            title: details.title,
            author: details.author,
            captions,
            source: "browser-android-player",
        });
    }

    async function run() {
        const videoId = getVideoId();
        if (!videoId) return;
        if (videoId === lastVideoId) return;
        lastVideoId = videoId;
        clearOverlays();
        log("run start for videoId", videoId);

        const details = getVideoDetailsFromDOM();
        log("video details:", JSON.stringify(details));

        const result = await fetchTranscriptInBrowser(details);
        log("scored:", JSON.stringify(result));
        setStatus(`${result.captionCount} segments, score ${result.score}`, "#81c784");
        showScore(result.score);
    }

    document.addEventListener("yt-navigate-finish", () => { run().catch(e => log("run error:", e.message)); });
    run().catch(e => log("run error:", e.message));
})();
