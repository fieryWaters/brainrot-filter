const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8787;
const LOG_DIR = path.join(__dirname, "ingest-log");
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL_QUICK = "llama3.2:1b";   // Phase 1 — title only, must be fast
const OLLAMA_MODEL_FULL  = "llama3.2:latest"; // Phase 2 — full transcript
const OLLAMA_TIMEOUT_QUICK_MS = 8000;  // bail if title score takes >8s
const OLLAMA_TIMEOUT_FULL_MS  = 30000;
const SCORE_CACHE_FILE = path.join(__dirname, "score-cache.json");
fs.mkdirSync(LOG_DIR, { recursive: true });

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

// ── Score cache ──────────────────────────────────────────────────────────────
let scoreCache = new Map();
try {
    const entries = JSON.parse(fs.readFileSync(SCORE_CACHE_FILE, "utf8"));
    scoreCache = new Map(Object.entries(entries));
    console.log(`[cache] loaded ${scoreCache.size} cached scores from disk`);
} catch (_) {}

function persistScoreCache() {
    fs.writeFileSync(SCORE_CACHE_FILE, JSON.stringify(Object.fromEntries(scoreCache), null, 2));
}

// ── Parental controls config ─────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, "config.json");
const DEFAULT_CONFIG = { threshold: 70, action: "blur", allowOverride: true };
let parentalConfig = { ...DEFAULT_CONFIG };

function loadConfig() {
    try {
        parentalConfig = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
        console.log(`[config] threshold=${parentalConfig.threshold} action=${parentalConfig.action} allowOverride=${parentalConfig.allowOverride}`);
    } catch (e) {
        console.log(`[config] using defaults (${e.message})`);
        parentalConfig = { ...DEFAULT_CONFIG };
    }
}
loadConfig();
fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => { console.log("[config] reloading..."); loadConfig(); });

// ── Two independent Ollama job slots — quick (1b) and full (3b) ──────────────
const _job = {
    quick: { abort: null, videoId: null },
    full:  { abort: null, videoId: null },
};

function cancelJob(slot, reason = "") {
    if (_job[slot].abort) {
        console.log(`[ollama:${slot}] cancel ${_job[slot].videoId}${reason ? " — " + reason : ""}`);
        _job[slot].abort.abort();
        _job[slot].abort = null;
        _job[slot].videoId = null;
    }
}

function cancelAll(reason) {
    cancelJob("quick", reason);
    cancelJob("full", reason);
}

async function ollamaCall(slot, model, timeoutMs, prompt, videoId) {
    cancelJob(slot, "new request");
    const controller = new AbortController();
    _job[slot].abort = controller;
    _job[slot].videoId = videoId;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(OLLAMA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.2, num_predict: 24 } }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ollama http ${res.status}`);
        const data = await res.json();
        const raw = (data.response || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        const m = raw.match(/\b(\d{1,3})\b/);
        if (!m) throw new Error(`no number in response: ${raw.slice(0, 80)}`);
        return Math.max(0, Math.min(100, parseInt(m[1], 10)));
    } finally {
        clearTimeout(timer);
        if (_job[slot].videoId === videoId) { _job[slot].abort = null; _job[slot].videoId = null; }
    }
}

// Phase 1 — llama3.2:1b scores just the title, should finish in 1-3s
async function scoreTitleWithOllama(title, author, videoId) {
    const prompt = `Score this YouTube video title for "brainrot" 0-100. Brainrot = low-effort addictive slop (pranks, reactions, meme rap, rage bait, skibidi/rizz/sigma slang, mindless compilations). Not brainrot = educational, sports, music, tutorials, news. Reply with ONE number only.\n\nTITLE: ${title}${author ? `\nCHANNEL: ${author}` : ""}\n\nSCORE:`;
    return ollamaCall("quick", OLLAMA_MODEL_QUICK, OLLAMA_TIMEOUT_QUICK_MS, prompt, videoId);
}

// Phase 2 — llama3.2:latest (3b) scores title + full transcript
async function scoreTranscriptWithOllama(text, title, videoId) {
    const titleLine = title ? `TITLE: ${title}\n` : "";
    const prompt = `Score this YouTube video for "brainrot" from 0 to 100.

BRAINROT (scores HIGH 60-100): reaction content, prank videos, skibidi/rizz/sigma/gyatt slang, rage bait, mindless compilations, meme rap, random animal edits with music, content designed to be addictive with no substance.

NOT BRAINROT (scores LOW 0-40): educational content, tutorials, documentaries, sports highlights, music performances, vlogs with real narrative, cooking, DIY, news.

MIDDLE (40-60): casual entertainment, funny videos with some substance, sports reactions.

${titleLine}TRANSCRIPT (may be in another language):
${text.slice(0, 40000)}

Reply with ONE number 0-100, nothing else.
SCORE:`;
    return ollamaCall("full", OLLAMA_MODEL_FULL, OLLAMA_TIMEOUT_FULL_MS, prompt, videoId);
}

// ── Fast keyword scorer (title + hashtags, <1ms) ─────────────────────────────
function scoreTitleFast(title = "", author = "") {
    const t = (title + " " + author).toLowerCase();
    let score = 0;

    const highSignals = [
        "skibidi", "rizz", "sigma", "gyatt", "ohio", "mewing", "fanum",
        "no cap", "bussin", "sheesh", "on god", "brainrot", "brain rot",
        "tralalero", "tralala", "patapim", "tung tung", "bombardiro",
        "orcalero", "capuccino", "italian brainrot", "brrr brrr",
        "slop", "npc", "glazing", "slay", "understood the assignment",
    ];
    const medSignals = [
        "prank", "reaction", "caught", "wait for it", "pov:", "he doesn't know",
        "compilation", "gone wrong", "exposed", "sus", "part 2", "part 3",
        "you won't believe", "watch till end", "ratio", "touch grass",
    ];
    const tagSpam = ["#fyp", "#foryou", "#viral", "#trending", "#prank", "#reaction", "#brainrot"];

    for (const w of highSignals) if (t.includes(w.toLowerCase())) score += 30;
    for (const w of medSignals) if (t.includes(w.toLowerCase())) score += 15;
    for (const tag of tagSpam) if (t.includes(tag)) score += 10;

    // Emoji overload
    const emojiCount = (title.match(/\p{Emoji_Presentation}/gu) || []).length;
    score += Math.min(emojiCount * 4, 24);

    return Math.min(100, score);
}

function scoreCaptions(captions) {
    const text = captions.map(c => c.text).join(" ").toLowerCase();
    if (!text) return 0;
    const triggers = [
        "skibidi", "rizz", "gyatt", "ohio", "sigma", "fanum tax", "mewing",
        "no cap", "bussin", "sus", "sheesh", "on god", "lowkey", "highkey",
        "based", "cringe", "cope", "mid", "goated",
    ];
    let hits = 0;
    for (const t of triggers) {
        const m = text.match(new RegExp(`\\b${t.replace(/\s+/g, "\\s+")}\\b`, "g"));
        if (m) hits += m.length;
    }
    const words = text.split(/\s+/).length;
    return Math.min(100, Math.round((words > 0 ? hits / words : 0) * 2000));
}

function safeFilename(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function readBody(req, limitBytes = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", c => {
            size += c.length;
            if (size > limitBytes) { reject(new Error("payload too large")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json", ...CORS });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === "GET" && req.url === "/health") { send(200, { ok: true }); return; }
    if (req.method === "GET" && req.url === "/config") { send(200, parentalConfig); return; }

    if (req.method === "POST" && req.url === "/log") {
        let entry = null;
        try { entry = JSON.parse(await readBody(req, 1024 * 1024)); } catch (_) {}
        if (entry) console.log(`[userscript] ${entry.videoId ? `[${entry.videoId}] ` : ""}${entry.msg || ""}`);
        send(200, { ok: true });
        return;
    }

    // Cancel all in-progress Ollama work for a video the user has left
    if (req.method === "POST" && req.url === "/cancel") {
        let videoId = null;
        try { ({ videoId } = JSON.parse(await readBody(req, 1024))); } catch (_) {}
        if (videoId) {
            if (_job.quick.videoId === videoId) cancelJob("quick", "user navigated away");
            if (_job.full.videoId === videoId) cancelJob("full", "user navigated away");
        }
        send(200, { ok: true });
        return;
    }

    // Phase 1: LLM title score (llama3.2:1b), falls back to keywords on timeout/error
    if (req.method === "POST" && req.url === "/score/quick") {
        let payload;
        try { payload = JSON.parse(await readBody(req, 64 * 1024)); } catch (e) { send(400, { error: e.message }); return; }
        const { videoId, title = "", author = "" } = payload;
        if (!videoId) { send(400, { error: "missing videoId" }); return; }

        if (scoreCache.has(videoId)) {
            const cached = scoreCache.get(videoId);
            console.log(`[cache] hit ${videoId} score=${cached.score}`);
            send(200, { ok: true, videoId, ...cached, scorer: "cache" });
            return;
        }

        const score = scoreTitleFast(title, author);
        console.log(`[quick] ${videoId} keyword=${score} title="${title.slice(0, 60)}"`);
        send(200, { ok: true, videoId, score, scorer: "title-keyword", phase: "quick" });
        return;
    }

    // Phase 2: full transcript + Ollama score
    if (req.method === "POST" && req.url === "/ingest") {
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) { send(400, { error: e.message }); return; }

        const { videoId, title = "", author = "" } = payload;
        if (!videoId) { send(400, { error: "missing videoId" }); return; }

        // Cached — no need to re-score
        if (scoreCache.has(videoId)) {
            const cached = scoreCache.get(videoId);
            console.log(`[cache] hit ${videoId} score=${cached.score}`);
            send(200, { ok: true, videoId, ...cached, scorer: "cache" });
            return;
        }

        let captions = Array.isArray(payload.captions) ? payload.captions : [];
        const source = payload.source || null;
        const language = payload.language || null;

        if (captions.length === 0 && !title) {
            send(200, { ok: false, error: "no-captions-no-title", videoId });
            return;
        }
        if (captions.length === 0) {
            console.log(`[transcript] no captions for ${videoId}, scoring title only: "${title.slice(0, 60)}"`);
        }

        const text = captions.map(c => c.text).join(" ");
        let score = 0;
        let scorer = "keyword";
        const t0 = Date.now();
        try {
            score = await scoreTranscriptWithOllama(text, title, videoId);
            scorer = "ollama-3b";
            console.log(`[full] ${videoId} score=${score} in ${Date.now() - t0}ms`);
        } catch (e) {
            score = scoreCaptions(captions) || scoreTitleFast(title, author);
            scorer = "keyword";
            console.log(`[full] ${videoId} ollama failed after ${Date.now() - t0}ms (${e.message.slice(0, 60)}), fallback=${score}`);
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
            path.join(LOG_DIR, `${stamp}_${safeFilename(videoId)}.json`),
            JSON.stringify({ videoId, title, author, language, source, captionCount: captions.length, captions, score, scorer }, null, 2)
        );
        console.log(`[ingest] ${videoId} "${title.slice(0, 50)}" - ${captions.length} segs - score ${score} (${scorer})`);

        scoreCache.set(videoId, { score, scorer, captionCount: captions.length, cachedAt: Date.now() });
        persistScoreCache();
        send(200, { ok: true, videoId, score, scorer, captionCount: captions.length, source });
        return;
    }

    send(404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`brainrot server on http://0.0.0.0:${PORT} (LAN: 192.168.2.52:${PORT})`);
    console.log(`ollama quick=${OLLAMA_MODEL_QUICK} full=${OLLAMA_MODEL_FULL} | cache: ${SCORE_CACHE_FILE}`);
});
