// ==UserScript==
// @name         Brainrot Filter POC
// @namespace    brainrot-filter
// @version      0.9.0
// @description  Fetch transcripts from the browser via YouTube's own get_transcript endpoint so every user hits YouTube with their own IP/cookies; server only scores.
// @match        *://*.youtube.com/*
// @run-at       document-idle
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.2.52
// ==/UserScript==

(function () {
    "use strict";

    // Set this to your laptop's LAN IP so iPhone can reach it on the same WiFi
    const SERVER = "http://192.168.2.52:8787";
    const BADGE_ID = "brainrot-score-badge";
    const STATUS_ID = "brainrot-status-badge";
    const BLOCK_ID = "brainrot-block-overlay";
    const CAPTURE_DURATION_MS = 30000;
    const POLL_INTERVAL_MS = 250;
    const CC_SETTLE_MS = 1500;
    const DEFAULT_CONFIG = { threshold: 999, action: "blur", allowOverride: true };

    let lastVideoId = null;
    let captureAbort = null;

    const GM_XHR = (typeof GM !== "undefined" && GM.xmlHttpRequest) || (typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : null);

    function serverRequest(path, payload, timeout = 30000) {
        return new Promise((resolve, reject) => {
            if (!GM_XHR) return reject(new Error("GM.xmlHttpRequest unavailable"));
            GM_XHR({
                method: "POST",
                url: `${SERVER}${path}`,
                data: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
                timeout,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) return reject(new Error(`server ${res.status}`));
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (_) { resolve({ ok: true }); }
                },
                onerror: (e) => reject(new Error(e?.error || "network error")),
                ontimeout: () => reject(new Error("timeout")),
            });
        });
    }

    function safeStringify(v) {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function remoteLog(msg) {
        serverRequest("/log", { msg, videoId: getVideoId(), t: Date.now() }, 5000).catch(() => {});
    }

    function log(...args) {
        const parts = args.map(a => typeof a === "string" ? a : safeStringify(a));
        const msg = parts.join(" ");
        console.log("[brainrot]", msg);
        remoteLog(msg);
    }

    function getVideoId() {
        const u = new URL(location.href);
        if (u.pathname === "/watch") return u.searchParams.get("v");
        const shorts = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
        if (shorts) return shorts[1];
        return null;
    }

    function parseTimestamp(ts) {
        const parts = (ts || "").trim().split(":").map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function getVideoDetailsFromDOM() {
        const vid = getVideoId();
        const titleEl = document.querySelector(
            "ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1.title"
        );
        const authorEl = document.querySelector(
            "ytd-video-owner-renderer ytd-channel-name a, ytd-video-owner-renderer #channel-name a, #owner #channel-name a"
        );
        const durEl = document.querySelector(".ytp-time-duration");
        const lengthSeconds = durEl ? parseTimestamp(durEl.textContent) : 0;
        return {
            videoId: vid,
            title: titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, ""),
            author: authorEl?.textContent?.trim() || "",
            lengthSeconds,
        };
    }

    function getPlayer() {
        // Desktop YouTube
        const desktop = document.querySelector(".html5-video-player");
        if (desktop) return desktop;
        // Mobile YouTube / Shorts — walk up from the video element to find a sized container
        const video = document.querySelector("video");
        if (!video) return null;
        let el = video.parentElement;
        while (el && el !== document.body) {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 100) {
                if (getComputedStyle(el).position === "static") el.style.position = "relative";
                return el;
            }
            el = el.parentElement;
        }
        return video.parentElement;
    }

    function setStatus(text, color) {
        const player = getPlayer();
        if (!player) return;
        let el = document.getElementById(STATUS_ID);
        if (!el) {
            el = document.createElement("div");
            el.id = STATUS_ID;
            Object.assign(el.style, {
                position: "absolute",
                top: "12px",
                left: "12px",
                padding: "4px 8px",
                background: "rgba(0,0,0,0.75)",
                color: "#fff",
                font: "500 11px -apple-system, sans-serif",
                borderRadius: "4px",
                zIndex: "60",
                pointerEvents: "none",
            });
            player.appendChild(el);
        }
        el.textContent = `brainrot: ${text}`;
        el.style.borderLeft = `3px solid ${color || "#888"}`;
    }

    function showScore(score) {
        const player = getPlayer();
        if (!player) return;
        let el = document.getElementById(BADGE_ID);
        if (!el) {
            el = document.createElement("div");
            el.id = BADGE_ID;
            Object.assign(el.style, {
                position: "absolute",
                top: "12px",
                right: "12px",
                minWidth: "54px",
                height: "54px",
                padding: "0 10px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.75)",
                color: "#fff",
                font: "700 22px -apple-system, sans-serif",
                borderRadius: "8px",
                zIndex: "60",
                pointerEvents: "none",
                lineHeight: "1",
            });
            player.appendChild(el);
        }
        const hue = Math.round(120 - (score / 100) * 120);
        el.style.borderBottom = `3px solid hsl(${hue}, 80%, 50%)`;
        el.innerHTML = `<div>${score}</div><div style="font:500 9px -apple-system,sans-serif;opacity:0.7;margin-top:2px">BRAINROT</div>`;
    }

    function clearOverlays() {
        document.getElementById(BADGE_ID)?.remove();
        document.getElementById(STATUS_ID)?.remove();
        document.getElementById(BLOCK_ID)?.remove();
    }

    function serverGet(path, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!GM_XHR) return reject(new Error("GM.xmlHttpRequest unavailable"));
            GM_XHR({
                method: "GET",
                url: `${SERVER}${path}`,
                timeout,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) return reject(new Error(`server ${res.status}`));
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (_) { resolve({}); }
                },
                onerror: (e) => reject(new Error(e?.error || "network error")),
                ontimeout: () => reject(new Error("timeout")),
            });
        });
    }

    async function fetchConfig() {
        try {
            const result = await serverGet("/config", 5000);
            return result || DEFAULT_CONFIG;
        } catch (_) {
            return DEFAULT_CONFIG; // server unreachable → don't block anything
        }
    }

    function applyBlock(score, config, video, holdInterval) {
        const player = getPlayer();
        if (!player) return;

        video = video || document.querySelector("video.html5-main-video, video");
        if (video) { video.pause(); video.muted = true; video.style.filter = "blur(20px)"; video.style.opacity = "0.4"; }

        let overlay = document.getElementById(BLOCK_ID);
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = BLOCK_ID;
            Object.assign(overlay.style, {
                position: "absolute",
                inset: "0",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.82)",
                color: "#fff",
                zIndex: "70",
                textAlign: "center",
                padding: "24px",
                boxSizing: "border-box",
            });
            player.appendChild(overlay);
        }

        const hue = Math.round(120 - (score / 100) * 120);
        const scoreColor = `hsl(${hue}, 80%, 50%)`;
        const actionLabel = config.action === "block" ? "Blocked" : "Blurred";

        overlay.innerHTML = `
            <div style="font:700 42px -apple-system,sans-serif;color:${scoreColor};line-height:1">${score}</div>
            <div style="font:600 13px -apple-system,sans-serif;opacity:0.6;margin:4px 0 16px;letter-spacing:.05em">BRAINROT SCORE</div>
            <div style="font:500 15px -apple-system,sans-serif;max-width:320px;line-height:1.5">
                ${actionLabel}: this content scored above your threshold (${config.threshold}/100).
            </div>
            ${config.allowOverride ? `
            <button id="brainrot-override-btn" style="
                margin-top:20px;padding:10px 24px;
                background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);
                color:#fff;border-radius:8px;font:600 14px -apple-system,sans-serif;
                cursor:pointer;-webkit-tap-highlight-color:transparent
            ">Watch anyway</button>` : ""}
        `;

        if (config.allowOverride) {
            document.getElementById("brainrot-override-btn")?.addEventListener("click", () => {
                overlay.remove();
                if (holdInterval) clearInterval(holdInterval);
                if (video) {
                    video.style.filter = "";
                    video.style.opacity = "";
                    video.muted = false;
                    video.play().catch(() => {});
                }
            });
        }
    }

    async function waitFor(predicate, { timeout = 10000, interval = 200 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const v = predicate();
            if (v) return v;
            await new Promise(r => setTimeout(r, interval));
        }
        return null;
    }

    async function enableCaptionsIfOff() {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (!btn) return { state: "no-button" };
        const before = btn.getAttribute("aria-pressed");
        if (before === "true") return { state: "already-on" };
        btn.click();
        await new Promise(r => setTimeout(r, CC_SETTLE_MS));
        const after = btn.getAttribute("aria-pressed");
        return { state: "clicked", before, after };
    }

    function dedupeStaircase(captions) {
        const out = [];
        for (let i = 0; i < captions.length; i++) {
            const cur = captions[i];
            const next = captions[i + 1];
            if (next && next.text.startsWith(cur.text)) continue;
            out.push(cur);
        }
        return out;
    }

    function captureCaptionsFromDOM({ video, durationMs, signal }) {
        return new Promise((resolve) => {
            const raw = [];
            let lastText = "";
            const start = Date.now();
            const tick = () => {
                if (signal?.aborted) { finish(); return; }
                const segs = document.querySelectorAll(".ytp-caption-segment");
                const text = Array.from(segs).map(s => s.textContent).join(" ").replace(/\s+/g, " ").trim();
                if (text && text !== lastText) {
                    raw.push({ tStart: video.currentTime, dur: 0, text });
                    lastText = text;
                }
                if (Date.now() - start >= durationMs) { finish(); return; }
                timer = setTimeout(tick, POLL_INTERVAL_MS);
            };
            let timer;
            const finish = () => {
                if (timer) clearTimeout(timer);
                resolve(dedupeStaircase(raw));
            };
            timer = setTimeout(tick, POLL_INTERVAL_MS);
        });
    }

    async function tryServerFetch(details) {
        setStatus("fetching full transcript...", "#64b5f6");
        try {
            const result = await serverRequest("/ingest", {
                videoId: details.videoId,
                title: details.title,
                author: details.author,
                lengthSeconds: details.lengthSeconds,
            });
            return result;
        } catch (e) {
            log("server request failed:", e.message);
            return { ok: false, error: "server-request-failed" };
        }
    }

    async function fallbackDOMCapture(details, signal) {
        log("falling back to live DOM capture");
        const ccResult = await enableCaptionsIfOff();
        log("CC toggle:", safeStringify(ccResult));
        if (ccResult.state === "no-button") {
            setStatus("no captions available", "#e53935");
            return null;
        }
        const video = document.querySelector("video.html5-main-video, video");
        if (video?.paused) {
            setStatus("press play to capture", "#ffb74d");
            await new Promise(r => video.addEventListener("play", r, { once: true }));
        }
        setStatus(`capturing ${CAPTURE_DURATION_MS / 1000}s of live captions...`, "#ffb74d");
        const captions = await captureCaptionsFromDOM({ video, durationMs: CAPTURE_DURATION_MS, signal });
        log("DOM capture got", captions.length, "segments after dedupe");
        if (signal.aborted || captions.length === 0) return null;
        setStatus("scoring...", "#64b5f6");
        try {
            return await serverRequest("/ingest", {
                videoId: details.videoId,
                title: details.title,
                author: details.author,
                lengthSeconds: details.lengthSeconds,
                captions,
                source: "dom-capture",
            });
        } catch (e) {
            log("fallback ingest failed:", e.message);
            return null;
        }
    }

    function getPageContext() {
        return new Promise((resolve) => {
            const nonce = "brainrot-" + Math.random().toString(36).slice(2);
            const onMsg = (e) => {
                if (e.source !== window) return;
                if (e.data?.__brainrot !== nonce) return;
                window.removeEventListener("message", onMsg);
                resolve(e.data.payload);
            };
            window.addEventListener("message", onMsg);
            const s = document.createElement("script");
            s.textContent = `(function(){
                function findTranscriptParams(obj) {
                    const panels = obj?.engagementPanels || [];
                    for (const p of panels) {
                        const sec = p?.engagementPanelSectionListRenderer;
                        const id = sec?.panelIdentifier || sec?.targetId;
                        if (id === "engagement-panel-searchable-transcript") {
                            return sec?.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params || null;
                        }
                    }
                    return null;
                }
                const cfg = window.ytcfg;
                const get = (k) => (cfg?.get ? cfg.get(k) : cfg?.data_?.[k]);
                const payload = {
                    apiKey: get("INNERTUBE_API_KEY"),
                    innertubeContext: get("INNERTUBE_CONTEXT"),
                    clientVersion: get("INNERTUBE_CLIENT_VERSION"),
                    clientName: get("INNERTUBE_CLIENT_NAME") || "WEB",
                    visitorData: get("VISITOR_DATA"),
                    hl: get("HL") || "en",
                    transcriptParams: findTranscriptParams(window.ytInitialData),
                };
                window.postMessage({ __brainrot: "${nonce}", payload }, "*");
            })();`;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            setTimeout(() => {
                window.removeEventListener("message", onMsg);
                resolve(null);
            }, 2000);
        });
    }

    function parseTranscriptResponse(data) {
        const actions = data?.actions || [];
        for (const a of actions) {
            const segs = a?.updateEngagementPanelAction?.content?.transcriptRenderer
                ?.content?.transcriptSearchPanelRenderer?.body
                ?.transcriptSegmentListRenderer?.initialSegments;
            if (!segs) continue;
            const out = [];
            for (const s of segs) {
                const r = s.transcriptSegmentRenderer;
                if (!r) continue;
                const text = (r.snippet?.runs || []).map(x => x.text).join("").trim();
                if (!text) continue;
                const startMs = Number(r.startMs || 0);
                const endMs = Number(r.endMs || 0);
                out.push({ tStart: startMs / 1000, dur: Math.max(0, (endMs - startMs) / 1000), text });
            }
            return out;
        }
        return [];
    }

    function parseTimedTextXml(xml) {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const texts = doc.getElementsByTagName("text");
        const out = [];
        const stripTags = (s) => s.replace(/<[^>]*>/g, "");
        const decode = (s) => {
            const t = document.createElement("textarea");
            t.innerHTML = s;
            return t.value;
        };
        for (const el of texts) {
            const raw = el.textContent || "";
            const text = stripTags(decode(raw)).trim();
            if (!text) continue;
            const tStart = parseFloat(el.getAttribute("start") || "0");
            const dur = parseFloat(el.getAttribute("dur") || "0");
            out.push({ tStart, dur, text });
        }
        return out;
    }

    async function fetchTranscriptInBrowser(details) {
        log("fetchTranscriptInBrowser start for", details.videoId);
        setStatus("reading page context...", "#64b5f6");
        const ctx = await getPageContext();
        if (!ctx) { log("page context: bridge timed out"); return null; }
        log("page context:", safeStringify({
            hasApiKey: !!ctx.apiKey,
            clientVersion: ctx.clientVersion,
        }));
        if (!ctx.apiKey) return null;

        async function callPlayer(clientLabel, clientName, clientVersion, clientNumber, credMode) {
            setStatus(`probing /player (${clientLabel})...`, "#64b5f6");
            try {
                const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(ctx.apiKey)}&prettyPrint=false`, {
                    method: "POST",
                    credentials: credMode,
                    headers: {
                        "Content-Type": "application/json",
                        "X-YouTube-Client-Name": String(clientNumber),
                        "X-YouTube-Client-Version": clientVersion,
                    },
                    body: JSON.stringify({
                        context: { client: { clientName, clientVersion, hl: ctx.hl || "en" } },
                        videoId: details.videoId,
                    }),
                });
                if (!res.ok) {
                    const txt = await res.text().catch(() => "");
                    log(`player(${clientLabel}) http`, res.status, txt.slice(0, 200));
                    return null;
                }
                return await res.json();
            } catch (e) {
                log(`player(${clientLabel}) fetch failed:`, e.message);
                return null;
            }
        }

        let playerData = await callPlayer("WEB", "WEB", ctx.clientVersion, 1, "include");
        let clientUsed = "WEB";
        let webBaseUrl = null;
        if (playerData) {
            const t = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            webBaseUrl = t[0]?.baseUrl || null;
            const pot = webBaseUrl && webBaseUrl.includes("&exp=xpe");
            log("WEB tracks:", t.length, "POT-gated?", pot);
            if (!t.length || pot) playerData = null;
        }
        if (!playerData) {
            playerData = await callPlayer("ANDROID", "ANDROID", "20.10.38", 3, "omit");
            clientUsed = "ANDROID";
        }
        if (!playerData) return null;

        const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        log("caption tracks:", tracks.length, tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(","));
        if (tracks.length === 0) return null;
        const pick = tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
        let baseUrl = (pick.baseUrl || "").replace("&fmt=srv3", "");
        const hasPot = baseUrl.includes("&exp=xpe");
        log("baseUrl POT-gated?", hasPot, "sample:", baseUrl.slice(0, 160));
        if (!baseUrl) return null;

        setStatus("fetching timedtext...", "#64b5f6");
        let xml;
        try {
            const res = await fetch(baseUrl, { credentials: "omit" });
            xml = await res.text();
            log("timedtext http", res.status, "len", xml.length, "head:", xml.slice(0, 120));
        } catch (e) {
            log("timedtext fetch failed:", e.message);
            return null;
        }
        if (!xml || xml.length < 40) return null;

        const captions = parseTimedTextXml(xml);
        log("parsed segments:", captions.length);
        if (captions.length === 0) return null;

        setStatus("scoring...", "#64b5f6");
        return await serverRequest("/ingest", {
            videoId: details.videoId,
            title: details.title,
            author: details.author,
            lengthSeconds: details.lengthSeconds,
            captions,
            source: `browser-${clientUsed.toLowerCase()}-player`,
        });
    }

    function startHold(vid) {
        if (!vid) return null;
        vid.pause();
        vid.muted = true;
        vid.style.filter = "blur(20px)";
        vid.style.opacity = "0.4";
        // Re-enforce every 300ms — YouTube's player fights back
        const interval = setInterval(() => {
            if (!vid.paused) vid.pause();
            if (!vid.muted) vid.muted = true;
        }, 300);
        return interval;
    }

    function liftHold(vid, holdInterval) {
        if (holdInterval) clearInterval(holdInterval);
        if (!vid) return;
        vid.style.filter = "";
        vid.style.opacity = "";
        vid.muted = false;
        vid.play().catch(() => {});
    }

    function applyResult(result, config, vid, holdInterval) {
        if (!result || !result.ok || typeof result.score !== "number") {
            liftHold(vid, holdInterval);
            setStatus("no score", "#888");
            return;
        }
        showScore(result.score);
        if (result.score >= config.threshold) {
            setStatus(`score ${result.score} — blocked`, "#e53935");
            applyBlock(result.score, config, vid, holdInterval);
        } else {
            liftHold(vid, holdInterval);
            setStatus(`score ${result.score}`, "#81c784");
        }
    }

    async function run() {
        const videoId = getVideoId();
        if (!videoId) return;
        if (videoId === lastVideoId) return;

        // Cancel server-side Ollama for the video we're leaving
        const prevVideoId = lastVideoId;
        lastVideoId = videoId;
        captureAbort?.abort();
        captureAbort = new AbortController();
        const signal = captureAbort.signal;
        clearOverlays();

        if (prevVideoId) {
            serverRequest("/cancel", { videoId: prevVideoId }, 2000).catch(() => {});
        }

        await waitFor(() => document.querySelector("video"));
        if (signal.aborted) return;
        const player = getPlayer();
        if (!player) return;

        const vid = document.querySelector("video");
        const holdInterval = startHold(vid);
        setStatus("checking...", "#64b5f6");

        // ── Phase 1: instant title keyword score (<50ms) ──────────────────────
        const [details, config] = await Promise.all([
            Promise.resolve(getVideoDetailsFromDOM()),
            fetchConfig(),
        ]);
        if (signal.aborted) { liftHold(vid, holdInterval); return; }

        const quickResult = await serverRequest("/score/quick", {
            videoId, title: details.title, author: details.author,
        }, 5000).catch(() => null);

        if (signal.aborted) { liftHold(vid, holdInterval); return; }

        if (quickResult?.scorer === "cache") {
            // Full cached score — no need for phase 2
            applyResult(quickResult, config, vid, holdInterval);
            return;
        }

        if (quickResult?.ok && quickResult.score >= config.threshold) {
            // Title alone is damning — block immediately, skip transcript
            log("phase1 block:", quickResult.score, details.title);
            applyResult(quickResult, config, vid, holdInterval);
            return;
        }

        // Title looks ok — release the hold and let the video play
        // Phase 2 runs silently and will intervene only if transcript score is high
        liftHold(vid, holdInterval);
        setStatus(`title ${quickResult?.score ?? "?"} — verifying...`, "#aaa");

        // ── Phase 2: wait 4s, then score transcript in background ──────────────
        await new Promise(r => setTimeout(r, 4000));
        if (signal.aborted) return;

        let result = await fetchTranscriptInBrowser(details);
        if (signal.aborted) return;
        if (!result || !result.ok) {
            result = await fallbackDOMCapture(details, signal);
        }
        if (signal.aborted) return;

        // Phase 2 result — only block if score is high, otherwise just show badge
        if (!result || !result.ok) {
            setStatus("no transcript", "#888");
            return;
        }
        showScore(result.score);
        if (result.score >= config.threshold) {
            log("phase2 block:", result.score, details.title);
            setStatus(`score ${result.score} — blocked`, "#e53935");
            const currentVid = document.querySelector("video");
            const newHold = startHold(currentVid);
            applyBlock(result.score, config, currentVid, newHold);
        } else {
            setStatus(`score ${result.score}`, "#81c784");
        }
    }

    document.addEventListener("yt-navigate-finish", () => { run().catch(e => log("run error:", e.message)); });
    window.addEventListener("popstate", () => { run().catch(e => log("run error:", e.message)); });

    // Poll for URL changes — catches Shorts navigation which doesn't fire yt-navigate-finish
    let _lastHref = location.href;
    setInterval(() => {
        if (location.href !== _lastHref) {
            _lastHref = location.href;
            run().catch(e => log("run error:", e.message));
        }
    }, 1000);

    run().catch(e => log("run error:", e.message));
})();
