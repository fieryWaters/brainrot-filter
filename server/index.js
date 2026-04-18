const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileP = promisify(execFile);

const PORT = 8787;
const LOG_DIR = path.join(__dirname, "ingest-log");
const TRANSCRIPT_DIR = path.join(__dirname, "transcript");
const OLLAMA_URL = "http://100.106.166.101:11434/api/generate";
const OLLAMA_MODEL = "qwen3.5:9b";
const OLLAMA_TIMEOUT_MS = 120000;
fs.mkdirSync(LOG_DIR, { recursive: true });

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const transcriptCache = new Map();

function readBody(req, limitBytes = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", c => {
            size += c.length;
            if (size > limitBytes) {
                reject(new Error("payload too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function fetchTranscriptPy(videoId) {
    if (transcriptCache.has(videoId)) return transcriptCache.get(videoId);
    const { stdout } = await execFileP(
        "uv",
        ["run", "python", "main.py", videoId],
        {
            cwd: TRANSCRIPT_DIR,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 25000,
        }
    );
    const result = JSON.parse(stdout);
    if (!result.ok) throw new Error(result.error || "python fetch failed");
    const value = { segments: result.segments, language: result.language };
    transcriptCache.set(videoId, value);
    return value;
}

async function scoreWithOllama(text) {
    const prompt = `You score a YouTube transcript for "brainrot" on a 0-100 scale. Brainrot = low-effort, hyper-stimulating, addictive content: Gen-Z slang overload (skibidi, rizz, sigma, no cap, etc.), empty filler, clickbait hype, mindless repetition, reaction-bait. Educational, technical, documentary, tutorial, artistic, and thoughtful content scores LOW even if casual. Calm narration scores low. 0 = serious educational. 50 = casual vlog. 100 = pure slop.

Respond with ONLY a single integer 0-100. No words, no explanation.

TRANSCRIPT:
${text.slice(0, 80000)}

SCORE:`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    try {
        const res = await fetch(OLLAMA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                think: false,
                options: { temperature: 0.2, num_predict: 24 },
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ollama http ${res.status}`);
        const data = await res.json();
        const raw = (data.response || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        const m = raw.match(/\b(\d{1,3})\b/);
        if (!m) throw new Error(`no number in: ${raw.slice(0, 100)}`);
        return Math.max(0, Math.min(100, parseInt(m[1], 10)));
    } finally {
        clearTimeout(timer);
    }
}

function scoreCaptions(captions) {
    const text = captions.map(c => c.text).join(" ").toLowerCase();
    if (!text) return 0;
    const triggers = [
        "skibidi", "rizz", "gyatt", "ohio", "sigma", "fanum tax", "mewing",
        "no cap", "bussin", "sus", "sheesh", "on god", "lowkey", "highkey",
        "based", "cringe", "cope", "mid", "goated", "slaps", "fire",
        "literally", "actually", "like", "bro", "dude",
    ];
    let hits = 0;
    for (const t of triggers) {
        const re = new RegExp(`\\b${t.replace(/\s+/g, "\\s+")}\\b`, "g");
        const m = text.match(re);
        if (m) hits += m.length;
    }
    const words = text.split(/\s+/).length;
    const density = words > 0 ? hits / words : 0;
    const score = Math.min(100, Math.round(density * 2000));
    return score;
}

function safeFilename(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const server = http.createServer(async (req, res) => {
    const send = (status, body, extraHeaders = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...CORS, ...extraHeaders });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    if (req.method === "GET" && req.url === "/health") {
        send(200, { ok: true });
        return;
    }

    if (req.method === "POST" && req.url === "/log") {
        let entry = null;
        try {
            const body = await readBody(req, 1024 * 1024);
            entry = JSON.parse(body);
        } catch (_) {}
        if (entry) {
            const vid = entry.videoId ? `[${entry.videoId}] ` : "";
            console.log(`[userscript] ${vid}${entry.msg || ""}`);
        }
        send(200, { ok: true });
        return;
    }

    if (req.method === "POST" && req.url === "/ingest") {
        let payload;
        try {
            const body = await readBody(req);
            payload = JSON.parse(body);
        } catch (e) {
            send(400, { error: e.message });
            return;
        }

        const { videoId, title = "", author = "" } = payload;
        if (!videoId) {
            send(400, { error: "missing videoId" });
            return;
        }

        let captions = Array.isArray(payload.captions) ? payload.captions : [];
        let source = payload.source || null;
        let language = payload.language || null;

        if (captions.length === 0) {
            // TEMP: python path disabled to verify browser path end-to-end
            console.log(`[transcript] python path disabled; refusing empty payload for ${videoId}`);
            send(200, { ok: false, error: "python-disabled", videoId });
            return;
        }

        const text = captions.map(c => c.text).join(" ");
        let score = 0;
        let scorer = "keyword";
        try {
            const t0 = Date.now();
            score = await scoreWithOllama(text);
            scorer = "ollama";
            console.log(`[score] ollama=${score} in ${Date.now() - t0}ms (${text.length} chars)`);
        } catch (e) {
            score = scoreCaptions(captions);
            console.log(`[score] ollama failed (${e.message.slice(0, 120)}), fallback keyword=${score}`);
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(LOG_DIR, `${stamp}_${safeFilename(videoId)}.json`);
        fs.writeFileSync(file, JSON.stringify({
            videoId, title, author, language, source,
            captionCount: captions.length,
            captions,
            score, scorer,
        }, null, 2));
        console.log(`[ingest] ${videoId} "${title}" by ${author} - ${captions.length} segments - score ${score} (${scorer}) - source ${source}`);
        send(200, { ok: true, videoId, score, scorer, captionCount: captions.length, source });
        return;
    }

    send(404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`brainrot server listening on http://0.0.0.0:${PORT} (tailscale: 100.94.9.65)`);
    console.log(`ingest logs -> ${LOG_DIR}`);
    console.log(`python transcript helper -> ${TRANSCRIPT_DIR}`);
});
