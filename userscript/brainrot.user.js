// ==UserScript==
// @name         Brainrot Filter
// @namespace    brainrot-filter
// @version      1.0.0
// @description  Score and blur addictive content on YouTube, TikTok, Instagram, Facebook, and Reddit.
// @match        *://*.youtube.com/*
// @match        *://*.tiktok.com/*
// @match        *://*.instagram.com/*
// @match        *://*.facebook.com/*
// @match        *://*.reddit.com/*
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

    // ── Server communication ──────────────────────────────────────────────────

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

    function safeStringify(v) {
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function log(...args) {
        const parts = args.map(a => typeof a === "string" ? a : safeStringify(a));
        const msg = parts.join(" ");
        console.log("[brainrot]", msg);
        serverRequest("/log", { msg, videoId: lastVideoId, t: Date.now() }, 5000).catch(() => {});
    }

    async function fetchConfig() {
        try {
            const result = await serverGet("/config", 5000);
            return result || DEFAULT_CONFIG;
        } catch (_) {
            return DEFAULT_CONFIG; // server unreachable → don't block anything
        }
    }

    // ── Platform detection ────────────────────────────────────────────────────

    function detectPlatform() {
        const h = location.hostname;
        if (h.includes("youtube.com")) return "youtube";
        if (h.includes("tiktok.com")) return "tiktok";
        if (h.includes("instagram.com")) return "instagram";
        if (h.includes("facebook.com") || h.includes("fb.com")) return "facebook";
        if (h.includes("reddit.com")) return "reddit";
        return null;
    }

    // ── Per-platform content extraction ──────────────────────────────────────
    //
    // Each extractor returns: { contentId, title, author, text, lengthSeconds? }
    // contentId  — unique cache key (prefixed per platform to avoid collisions)
    // text       — description/caption text for LLM scoring (null for YouTube, uses transcript)

    function getYouTubeDetails() {
        const u = new URL(location.href);
        let videoId = null;
        if (u.pathname === "/watch") videoId = u.searchParams.get("v");
        const shorts = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
        if (shorts) videoId = shorts[1];
        if (!videoId) return null;

        const titleEl = document.querySelector(
            "ytd-watch-metadata h1 yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h1.title"
        );
        const authorEl = document.querySelector(
            "ytd-video-owner-renderer ytd-channel-name a, ytd-video-owner-renderer #channel-name a, #owner #channel-name a"
        );
        const durEl = document.querySelector(".ytp-time-duration");
        return {
            contentId: videoId,
            title: titleEl?.textContent?.trim() || document.title.replace(/ - YouTube$/, ""),
            author: authorEl?.textContent?.trim() || "",
            lengthSeconds: durEl ? parseTimestamp(durEl.textContent) : 0,
            text: null, // YouTube uses transcript fetching, not description text
        };
    }

    function getTikTokDetails() {
        // Video page URL: /@username/video/VIDEO_ID
        // For You feed: URL updates to the above as you scroll
        const m = location.pathname.match(/\/@([^/]+)\/video\/(\d+)/);
        if (!m) return null;

        const author = m[1];
        const contentId = `tiktok_${m[2]}`;

        // TikTok's class names change, use data-e2e attributes which are stable
        const descEl =
            document.querySelector('[data-e2e="browse-video-desc"]') ||
            document.querySelector('[data-e2e="video-desc"]') ||
            document.querySelector('h1[data-e2e="video-title"]') ||
            document.querySelector('.video-meta-caption');
        const title = descEl?.textContent?.trim() || document.title.replace(/ \| TikTok$/, "").trim();

        return { contentId, title, author, text: title };
    }

    function getInstagramDetails() {
        // Reels: /reel/ID/    Posts: /p/ID/
        // Feed pages (/, /reels/, /explore/) are handled by setupInstagramFeedObserver
        const m = location.pathname.match(/\/(?:reel|p)\/([a-zA-Z0-9_-]+)/);
        if (!m) return null;

        const contentId = `ig_${m[1]}`;

        // Scope selectors to `article` — the unscoped ._aade can hit the "Follow" button
        const article = document.querySelector("article");
        const captionEl =
            article?.querySelector('._aade') ||
            article?.querySelector('h1') ||
            article?.querySelector('[class*="Caption"] span') ||
            article?.querySelector('ul li span[dir="auto"]');
        const title = captionEl?.textContent?.trim() ||
            document.title.replace(/ • Instagram.*$/, "").trim();

        const usernameEl =
            article?.querySelector('header a[role="link"]') ||
            article?.querySelector('header h2 a') ||
            document.querySelector('header a.notranslate');
        const author = usernameEl?.textContent?.trim() || "";

        return { contentId, title, author, text: title };
    }

    // Extract caption/author for a specific video element in the Instagram feed
    function getInstagramVideoContext(videoEl) {
        // Walk up to the nearest article container (post boundary)
        let el = videoEl.parentElement;
        let depth = 0;
        while (el && el !== document.body && depth < 25) {
            if (el.tagName === "ARTICLE") break;
            el = el.parentElement;
            depth++;
        }
        const article = (el && el.tagName === "ARTICLE") ? el : null;

        // Try to get stable shortcode from a post link inside this article
        const postLink = article?.querySelector('a[href*="/p/"], a[href*="/reel/"]');
        const shortcodeM = postLink?.getAttribute("href")?.match(/\/(?:p|reel)\/([a-zA-Z0-9_-]+)/);
        const shortcode = shortcodeM?.[1];

        const captionEl =
            article?.querySelector('._aade') ||
            article?.querySelector('[class*="Caption"] span') ||
            article?.querySelector('ul li span[dir="auto"]') ||
            article?.querySelector('h2');
        const title = captionEl?.textContent?.trim() || "";

        const usernameEl = article?.querySelector('header a[role="link"]') || article?.querySelector('header h2 a');
        const author = usernameEl?.textContent?.trim() || "";

        const contentId = shortcode
            ? `ig_${shortcode}`
            : `ig_feed_${simpleHash((title || "") + (author || "") + (videoEl.src || "").slice(-30))}`;

        return { contentId, title, author, text: title };
    }

    function getFacebookDetails() {
        const u = new URL(location.href);
        // Reels: /reel/ID    Watch: /watch?v=ID or /video/ID
        const reelM = u.pathname.match(/\/reel\/(\d+)/);
        const videoM = u.pathname.match(/\/video\/(\d+)/);
        const videoId = reelM?.[1] || videoM?.[1] || u.searchParams.get("v");
        if (!videoId) return null;

        const contentId = `fb_${videoId}`;

        // Facebook uses obfuscated atomic class names — target semantic attributes
        const titleEl =
            document.querySelector('[role="article"] h2[dir="auto"]') ||
            document.querySelector('[role="main"] h2[dir="auto"]') ||
            document.querySelector('h2[dir="auto"]');
        const title = titleEl?.textContent?.trim() ||
            document.title.replace(/ \| Facebook$/, "").trim();

        return { contentId, title, author: "", text: title };
    }

    function getRedditDetails() {
        // Post pages: /r/subreddit/comments/POST_ID/title_slug/
        // Feed pages (/r/funny, /r/all) are NOT handled here — would need MutationObserver
        const m = location.pathname.match(/\/r\/([^/]+)\/comments\/([a-zA-Z0-9]+)/);
        if (!m) return null;

        const subreddit = m[1];
        const contentId = `reddit_${m[2]}`;

        // Support both Shreddit (new) and legacy new Reddit
        const shreddit = document.querySelector("shreddit-post");
        const titleEl =
            (shreddit && (shreddit.querySelector('[slot="title"]') || shreddit.querySelector('h1'))) ||
            document.querySelector('[data-testid="post-title"]') ||
            document.querySelector('.Post h1') ||
            document.querySelector('[id^="post-title"]') ||
            document.querySelector('h1');
        const title = titleEl?.textContent?.trim() ||
            document.title.replace(/ : r\/.*$/, "").replace(/ - Reddit$/, "").trim();

        const authorEl =
            document.querySelector('a[data-testid="post_author_link"]') ||
            (shreddit && shreddit.querySelector('[slot="authorName"] a')) ||
            document.querySelector('a[href*="/user/"]');
        const author = authorEl?.textContent?.trim()?.replace(/^u\//, "") || "";

        // Include subreddit in text so LLM has context (e.g. r/teenagers signals different content than r/science)
        return { contentId, title, author, text: `${title} (r/${subreddit})`, subreddit };
    }

    function getPlatformDetails(platform) {
        switch (platform) {
            case "youtube":   return getYouTubeDetails();
            case "tiktok":    return getTikTokDetails();
            case "instagram": return getInstagramDetails();
            case "facebook":  return getFacebookDetails();
            case "reddit":    return getRedditDetails();
            default:          return null;
        }
    }

    // ── DOM utilities ─────────────────────────────────────────────────────────

    function parseTimestamp(ts) {
        const parts = (ts || "").trim().split(":").map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function getPlayerForVideo(video) {
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

    function getPlayer() {
        // Desktop YouTube
        const desktop = document.querySelector(".html5-video-player");
        if (desktop) return desktop;
        // All other platforms — walk up from <video>
        const video = document.querySelector("video");
        if (video) return getPlayerForVideo(video);
        // No video — use post container (Reddit text posts, etc.)
        const postContainer =
            document.querySelector("shreddit-post") ||
            document.querySelector('[data-testid="post-container"]') ||
            document.querySelector("main article");
        if (postContainer) {
            if (getComputedStyle(postContainer).position === "static") {
                postContainer.style.position = "relative";
            }
            return postContainer;
        }
        return null;
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

    // ── UI ────────────────────────────────────────────────────────────────────

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

    function applyBlock(score, config, video, holdInterval) {
        const player = getPlayer();
        if (!player) return;

        video = video || document.querySelector("video");
        if (video) {
            video.pause();
            video.muted = true;
            video.style.filter = "blur(20px)";
            video.style.opacity = "0.4";
        }

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

    // ── Video hold ────────────────────────────────────────────────────────────

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
            if (vid) liftHold(vid, holdInterval);
            setStatus("no score", "#888");
            return;
        }
        showScore(result.score);
        if (result.score >= config.threshold) {
            setStatus(`score ${result.score} — blocked`, "#e53935");
            applyBlock(result.score, config, vid, holdInterval);
        } else {
            if (vid) liftHold(vid, holdInterval);
            setStatus(`score ${result.score}`, "#81c784");
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    function simpleHash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
        return Math.abs(h).toString(36);
    }

    // ── Non-YouTube Phase 2: score description text via /ingest ───────────────

    async function scoreWithDescriptionText(details) {
        const text = details.text || "";
        const captions = text ? [{ tStart: 0, dur: 0, text }] : [];
        setStatus("scoring...", "#64b5f6");
        return serverRequest("/ingest", {
            videoId: details.contentId,
            title: details.title,
            author: details.author,
            captions,
            source: "description",
        }, 30000).catch(e => { log("description score failed:", e.message); return null; });
    }

    // ── YouTube-specific: transcript fetching ─────────────────────────────────

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
            let timer;
            const finish = () => { if (timer) clearTimeout(timer); resolve(dedupeStaircase(raw)); };
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
            timer = setTimeout(tick, POLL_INTERVAL_MS);
        });
    }

    async function fallbackDOMCapture(details, signal) {
        log("falling back to live DOM caption capture");
        const btn = document.querySelector(".ytp-subtitles-button");
        if (!btn) { setStatus("no captions available", "#e53935"); return null; }
        if (btn.getAttribute("aria-pressed") !== "true") {
            btn.click();
            await new Promise(r => setTimeout(r, CC_SETTLE_MS));
        }
        const video = document.querySelector("video");
        if (video?.paused) {
            setStatus("press play to capture", "#ffb74d");
            await new Promise(r => video.addEventListener("play", r, { once: true }));
        }
        setStatus(`capturing ${CAPTURE_DURATION_MS / 1000}s of live captions...`, "#ffb74d");
        const captions = await captureCaptionsFromDOM({ video, durationMs: CAPTURE_DURATION_MS, signal });
        log("DOM capture got", captions.length, "segments after dedupe");
        if (signal.aborted || captions.length === 0) return null;
        setStatus("scoring...", "#64b5f6");
        return serverRequest("/ingest", {
            videoId: details.contentId,
            title: details.title,
            author: details.author,
            lengthSeconds: details.lengthSeconds || 0,
            captions,
            source: "dom-capture",
        }).catch(e => { log("fallback ingest failed:", e.message); return null; });
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
            setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 2000);
        });
    }

    function parseTimedTextXml(xml) {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const texts = doc.getElementsByTagName("text");
        const out = [];
        const decode = (s) => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };
        for (const el of texts) {
            const raw = el.textContent || "";
            const text = decode(raw.replace(/<[^>]*>/g, "")).trim();
            if (!text) continue;
            const tStart = parseFloat(el.getAttribute("start") || "0");
            const dur = parseFloat(el.getAttribute("dur") || "0");
            out.push({ tStart, dur, text });
        }
        return out;
    }

    async function fetchTranscriptInBrowser(details) {
        log("fetchTranscriptInBrowser start for", details.contentId);
        setStatus("reading page context...", "#64b5f6");
        const ctx = await getPageContext();
        if (!ctx?.apiKey) { log("page context: no apiKey"); return null; }

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
                        videoId: details.contentId,
                    }),
                });
                if (!res.ok) { log(`player(${clientLabel}) http ${res.status}`); return null; }
                return await res.json();
            } catch (e) {
                log(`player(${clientLabel}) fetch failed:`, e.message);
                return null;
            }
        }

        let playerData = await callPlayer("WEB", "WEB", ctx.clientVersion, 1, "include");
        if (playerData) {
            const t = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            const webBaseUrl = t[0]?.baseUrl || null;
            const pot = webBaseUrl && webBaseUrl.includes("&exp=xpe");
            log("WEB tracks:", t.length, "POT-gated?", pot);
            if (!t.length || pot) playerData = null;
        }
        if (!playerData) playerData = await callPlayer("ANDROID", "ANDROID", "20.10.38", 3, "omit");
        if (!playerData) return null;

        const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        log("caption tracks:", tracks.length, tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`).join(","));
        if (tracks.length === 0) return null;

        const pick = tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
        const baseUrl = (pick.baseUrl || "").replace("&fmt=srv3", "");
        if (!baseUrl) return null;

        setStatus("fetching timedtext...", "#64b5f6");
        let xml;
        try {
            const res = await fetch(baseUrl, { credentials: "omit" });
            xml = await res.text();
            log("timedtext http", res.status, "len", xml.length);
        } catch (e) { log("timedtext fetch failed:", e.message); return null; }
        if (!xml || xml.length < 40) return null;

        const captions = parseTimedTextXml(xml);
        log("parsed segments:", captions.length);
        if (captions.length === 0) return null;

        setStatus("scoring...", "#64b5f6");
        return serverRequest("/ingest", {
            videoId: details.contentId,
            title: details.title,
            author: details.author,
            lengthSeconds: details.lengthSeconds || 0,
            captions,
            source: "browser-player",
        });
    }

    // ── Main run loop ─────────────────────────────────────────────────────────

    async function run() {
        const platform = detectPlatform();
        if (!platform) return;

        const details = getPlatformDetails(platform);
        if (!details?.contentId) return;
        if (details.contentId === lastVideoId) return;

        const prevVideoId = lastVideoId;
        lastVideoId = details.contentId;
        captureAbort?.abort();
        captureAbort = new AbortController();
        const signal = captureAbort.signal;
        clearOverlays();

        if (prevVideoId) {
            serverRequest("/cancel", { videoId: prevVideoId }, 2000).catch(() => {});
        }

        // Wait for video element — shorter timeout on non-YouTube (text posts have no video)
        const vid = await waitFor(() => document.querySelector("video"), {
            timeout: platform === "youtube" ? 10000 : 3000,
        });
        if (signal.aborted) return;

        const holdInterval = vid ? startHold(vid) : null;
        setStatus("checking...", "#64b5f6");

        // Re-read details now (DOM may have settled more since initial check)
        const [freshDetails, config] = await Promise.all([
            Promise.resolve(getPlatformDetails(platform) || details),
            fetchConfig(),
        ]);
        if (signal.aborted) { if (vid) liftHold(vid, holdInterval); return; }

        // ── Phase 1: instant title keyword score (<50ms) ──────────────────────
        const quickResult = await serverRequest("/score/quick", {
            videoId: freshDetails.contentId,
            title: freshDetails.title,
            author: freshDetails.author,
        }, 5000).catch(() => null);

        if (signal.aborted) { if (vid) liftHold(vid, holdInterval); return; }

        if (quickResult?.scorer === "cache") {
            // Full cached score — skip phase 2
            applyResult(quickResult, config, vid, holdInterval);
            return;
        }

        if (quickResult?.ok && quickResult.score >= config.threshold) {
            // Title alone is damning — block immediately
            log(`[${platform}] phase1 block: ${quickResult.score} "${freshDetails.title.slice(0, 60)}"`);
            applyResult(quickResult, config, vid, holdInterval);
            return;
        }

        // Title passed — lift hold, let video play while we do background scoring
        if (vid) liftHold(vid, holdInterval);
        setStatus(`title ${quickResult?.score ?? "?"} — verifying...`, "#aaa");

        // ── Phase 2: background content scoring ───────────────────────────────
        const phase2DelayMs = platform === "youtube" ? 4000 : 2000;
        await new Promise(r => setTimeout(r, phase2DelayMs));
        if (signal.aborted) return;

        let result;
        if (platform === "youtube") {
            result = await fetchTranscriptInBrowser(freshDetails);
            if (signal.aborted) return;
            if (!result?.ok) result = await fallbackDOMCapture(freshDetails, signal);
        } else {
            // Re-read now that the page has had 2s to finish rendering
            const latestDetails = getPlatformDetails(platform) || freshDetails;
            result = await scoreWithDescriptionText(latestDetails);
        }

        if (signal.aborted) return;

        if (!result?.ok) {
            setStatus("no score", "#888");
            return;
        }

        showScore(result.score);
        if (result.score >= config.threshold) {
            log(`[${platform}] phase2 block: ${result.score} "${freshDetails.title.slice(0, 60)}"`);
            setStatus(`score ${result.score} — blocked`, "#e53935");
            const currentVid = document.querySelector("video");
            const newHold = currentVid ? startHold(currentVid) : null;
            applyBlock(result.score, config, currentVid, newHold);
        } else {
            setStatus(`score ${result.score}`, "#81c784");
        }
    }

    // ── Instagram feed observer ───────────────────────────────────────────────
    //
    // The home feed (/) and Reels tab (/reels/) don't update the URL per post,
    // so URL polling never fires. Instead we watch for videos entering the viewport.

    function setupInstagramFeedObserver() {
        // Only run on Instagram feed pages — individual post pages are handled by run()
        if (!location.hostname.includes("instagram.com")) return;
        if (location.pathname.match(/\/(?:reel|p)\/[a-zA-Z0-9_-]+/)) return;

        let debounceTimer = null;

        const scoreVisibleVideo = async (vid) => {
            const ctx = getInstagramVideoContext(vid);
            if (!ctx?.contentId || ctx.contentId === lastVideoId) return;

            lastVideoId = ctx.contentId;
            clearOverlays();
            captureAbort?.abort();
            captureAbort = new AbortController();
            const signal = captureAbort.signal;

            const holdInterval = startHold(vid);
            const config = await fetchConfig();
            if (signal.aborted) { liftHold(vid, holdInterval); return; }

            const quickResult = await serverRequest("/score/quick", {
                videoId: ctx.contentId, title: ctx.title, author: ctx.author,
            }, 5000).catch(() => null);
            if (signal.aborted) { liftHold(vid, holdInterval); return; }

            if (quickResult?.scorer === "cache" || (quickResult?.ok && quickResult.score >= config.threshold)) {
                applyResult(quickResult, config, vid, holdInterval);
                return;
            }

            liftHold(vid, holdInterval);
            setStatus(`title ${quickResult?.score ?? "?"} — verifying...`, "#aaa");

            await new Promise(r => setTimeout(r, 1500));
            if (signal.aborted) return;

            const latestCtx = getInstagramVideoContext(vid) || ctx;
            const result = await scoreWithDescriptionText(latestCtx).catch(() => null);
            if (signal.aborted) return;

            if (!result?.ok) { setStatus("no score", "#888"); return; }
            showScore(result.score);
            if (result.score >= config.threshold) {
                log(`[instagram-feed] block: ${result.score} "${latestCtx.title.slice(0, 60)}"`);
                setStatus(`score ${result.score} — blocked`, "#e53935");
                const newHold = startHold(vid);
                applyBlock(result.score, config, vid, newHold);
            } else {
                setStatus(`score ${result.score}`, "#81c784");
            }
        };

        const intersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
                const vid = entry.target;
                // Debounce: wait for the user to settle on a reel before scoring
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => scoreVisibleVideo(vid).catch(e => log("feed score error:", e.message)), 600);
                break;
            }
        }, { threshold: 0.5 });

        const watchNewVideos = () => {
            document.querySelectorAll("video:not([data-br-watched])").forEach(vid => {
                vid.setAttribute("data-br-watched", "1");
                intersectionObserver.observe(vid);
            });
        };

        const mutationObserver = new MutationObserver(watchNewVideos);
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        watchNewVideos();
    }

    // ── Navigation event listeners ────────────────────────────────────────────

    // YouTube's own navigation event (SPA)
    document.addEventListener("yt-navigate-finish", () => { run().catch(e => log("run error:", e.message)); });
    // Browser back/forward
    window.addEventListener("popstate", () => { run().catch(e => log("run error:", e.message)); });

    // URL polling — catches SPA navigation on all platforms (TikTok, Instagram, Reddit, etc.)
    let _lastHref = location.href;
    setInterval(() => {
        if (location.href !== _lastHref) {
            _lastHref = location.href;
            run().catch(e => log("run error:", e.message));
        }
    }, 1000);

    run().catch(e => log("run error:", e.message));
    setupInstagramFeedObserver();
})();
