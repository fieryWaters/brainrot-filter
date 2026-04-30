const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8787;
const LOG_DIR = path.join(__dirname, "ingest-log");

const OLLAMA_URL = (process.env.OLLAMA_URL || "").trim();
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "qwen3.5:9b").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || "qwen/qwen3.5-9b").trim();
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const LLM_TIMEOUT_MS = 120000;
const TRANSCRIPT_CHAR_LIMIT = 80000;

const PROVIDER = OLLAMA_URL ? "ollama" : (OPENROUTER_API_KEY ? "openrouter" : "none");

fs.mkdirSync(LOG_DIR, { recursive: true });

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

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

const SCORING_RULES =`You score a YouTube transcript for "brainrot" on a 0-100 scale. Brainrot = low-effort, hyper-stimulating, addictive content: Gen-Z slang overload (skibidi, rizz, sigma, no cap, etc.), empty filler, clickbait hype, mindless repetition, reaction-bait. Educational, technical, documentary, tutorial, artistic, and thoughtful content scores LOW even if casual. Calm narration scores low. 0 = serious educational. 50 = casual vlog. 100 = pure slop.

Respond with ONLY a single integer 0-100. No words, no explanation.`;

function parseScore(raw) {
    const cleaned = (raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const m = cleaned.match(/\b(\d{1,3})\b/);
    if (!m) throw new Error(`no number in: ${cleaned.slice(0, 100)}`);
    return Math.max(0, Math.min(100, parseInt(m[1], 10)));
}

async function scoreWithOllama(text) {
    const res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: `${SCORING_RULES}\n\nTRANSCRIPT:\n${text}\n\nSCORE:`,
            stream: false,
            think: false,
            options: { temperature: 0.2, num_predict: 24 },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama http ${res.status}`);
    const data = await res.json();
    return parseScore(data.response);
}

async function scoreWithOpenRouter(text) {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
    const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            messages: [
                { role: "system", content: SCORING_RULES },
                { role: "user", content: `TRANSCRIPT:\n${text}\n\nSCORE:` },
            ],
            temperature: 0.2,
            max_tokens: 24,
            reasoning: { enabled: false },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`openrouter http ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return parseScore(data?.choices?.[0]?.message?.content || "");
}

async function scoreLLM(text) {
    const truncated = text.slice(0, TRANSCRIPT_CHAR_LIMIT);
    if (PROVIDER === "ollama") return { score: await scoreWithOllama(truncated), scorer: "ollama" };
    if (PROVIDER === "openrouter") return { score: await scoreWithOpenRouter(truncated), scorer: "openrouter" };
    throw new Error("no LLM provider configured (set OPENROUTER_API_KEY or OLLAMA_URL)");
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
            console.log(`[ingest] ${videoId} no captions in payload`);
            send(200, { ok: false, error: "no-captions", videoId });
            return;
        }

        const text = captions.map(c => c.text).join(" ");
        let score = 0;
        let scorer = "keyword";
        try {
            const t0 = Date.now();
            const result = await scoreLLM(text);
            score = result.score;
            scorer = result.scorer;
            console.log(`[score] ${scorer}=${score} in ${Date.now() - t0}ms (${text.length} chars)`);
        } catch (e) {
            score = scoreCaptions(captions);
            console.log(`[score] llm failed (${e.message.slice(0, 120)}), fallback keyword=${score}`);
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
    let providerLine;
    if (PROVIDER === "ollama") providerLine = `provider=ollama url=${OLLAMA_URL} model=${OLLAMA_MODEL}`;
    else if (PROVIDER === "openrouter") providerLine = `provider=openrouter model=${OPENROUTER_MODEL}`;
    else providerLine = `provider=NONE (set OPENROUTER_API_KEY or OLLAMA_URL) - will fall back to keyword scoring`;
    console.log(`brainrot server listening on http://0.0.0.0:${PORT}`);
    console.log(providerLine);
    console.log(`ingest logs -> ${LOG_DIR}`);
});
