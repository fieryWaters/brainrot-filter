# brainrot-filter

Proof of concept for a YouTube "brainrot score" overlay. A Safari userscript
extracts the full transcript of the current video from the browser, sends it
to a small Node server (running in Docker), which forwards it to an LLM for
scoring 0-100, and paints the score as a badge on the video player.

Default LLM provider is OpenRouter (cloud, requires only an API key). The
server can also be pointed at a self-hosted Ollama instance via env var.

---

## Architecture

```
[Safari userscript]  --transcript-->  [Node server (Docker)]  --prompt-->  [LLM provider]
                                          0.0.0.0:8787                     OpenRouter | Ollama
      |                                                                        |
      `------------------------ score (0-100) <-----------------------------'
```

| Piece               | Where                              | Role                                                                 |
|---------------------|------------------------------------|----------------------------------------------------------------------|
| Userscript          | Safari (Mac + iPhone)              | Reads video metadata, fetches transcript via YouTube InnerTube       |
| Node server         | Docker container, port 8787        | Receives transcript, calls LLM, logs JSON, returns score             |
| OpenRouter (default)| https://openrouter.ai              | Scores a transcript 0-100 (model: `qwen/qwen3.5-9b` by default)      |
| Ollama (optional)   | self-hosted, e.g. via Tailscale    | Same role, different provider                                        |

### Transcript fetch path

Userscript calls YouTube's internal `/youtubei/v1/player` endpoint with
`clientName: "ANDROID"` + `clientVersion: "20.10.38"`, no session cookies.
This returns caption tracks whose `baseUrl` is not POT-token-gated. The
userscript then fetches that baseUrl, gets XML, parses into segments.

The WEB client is tried first for fingerprint consistency but YouTube now
silently strips captions from WEB responses without a POT token, so the code
falls back to ANDROID. Same trick every working YouTube scraper uses.

All transcript fetching happens from the user's browser, on the user's own
residential IP - not from a cloud server that would be blanket-blocked.

---

## Quick start (Docker)

```
git clone <this repo>
cd brainrot-filter
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY
docker compose up --build
```

The server listens on `http://0.0.0.0:8787`. Sanity check:

```
curl http://localhost:8787/health
```

Then install the userscript in Safari (see below) and open a YouTube video.

### Userscript on Mac Safari

After editing `userscript/brainrot.user.js`:

```
./sync-userscript.sh
```

Click the Userscripts toolbar icon in Safari and hit Refresh so the extension
re-scans. `SERVER` is set to `http://localhost:8787` by default.

### Userscript on iPhone Safari

1. Install **Userscripts** from the App Store (same dev as the Mac app).
2. Settings -> Safari -> Extensions -> Userscripts -> toggle on, set
   Permissions -> All Websites -> Allow.
3. Edit `userscript/brainrot.user.js` and change `SERVER` to the address of
   the machine running Docker (e.g. its LAN IP or Tailscale IP). Also add
   that host to the `// @connect` directives at the top of the script.
4. Open the Userscripts app, tap `+`, paste the contents of
   `userscript/brainrot.user.js`. Save.
5. In Safari, browse to a YouTube video. Badge appears on the player.

### Locking the iOS extension (Screen Time)

Once the userscript is installed and working, the extension can be locked in
place so a user cannot disable it without the Screen Time passcode.

1. iPhone: Settings -> Screen Time -> **Content & Privacy Restrictions** ->
   toggle on.
2. Content Restrictions -> **Web Content** -> change from *Unrestricted* to
   **Limit Adult Websites** (or **Allowed Websites Only** for the strictest
   setup).
3. Set a Screen Time passcode different from the device passcode.

Effect: once Web Content is not *Unrestricted*, the Safari Extensions
management UI requires the Screen Time passcode to toggle extensions off.
Userscripts stays enabled and the brainrot badge stays active.

---

## Configuration

All config is in `.env` (see `.env.example`):

| Var                  | Required? | Default                | Notes                                       |
|----------------------|-----------|------------------------|---------------------------------------------|
| `OPENROUTER_API_KEY` | yes*      | -                      | Required unless `OLLAMA_URL` is set         |
| `OPENROUTER_MODEL`   | no        | `qwen/qwen3.5-9b`      | Any OpenRouter model id                     |
| `OLLAMA_URL`         | no        | -                      | If set, Ollama is used and OpenRouter is ignored |
| `OLLAMA_MODEL`       | no        | `qwen3.5:9b`           | Only used when `OLLAMA_URL` is set          |

If neither provider is configured (or both fail), the server falls back to a
small keyword-density scorer so the pipeline still returns a number.

---

## Advanced: self-hosted Ollama via Tailscale

If you have an Ollama box on your Tailnet (or LAN) you can route scoring
there instead of OpenRouter. In `.env`:

```
OLLAMA_URL=http://100.106.166.101:11434/api/generate
OLLAMA_MODEL=qwen3.5:9b
```

Then `docker compose up --build` again. The Docker container reaches the
Tailscale IP through the host's network (Tailscale runs on the host, not in
the container).

For iPhone use: install Tailscale on the phone, then point the userscript's
`SERVER` constant at the Mac's Tailscale IP. Also make sure Tailscale
**Shields Up** is off on the Mac:

```
/Applications/Tailscale.app/Contents/MacOS/Tailscale set --shields-up=false
```

---

## Repo layout

```
Dockerfile                    Server image (node:20-alpine, stdlib only)
docker-compose.yml            Single service on port 8787
.env.example                  Provider config template
userscript/brainrot.user.js   Safari Userscripts source of truth
server/index.js               Node server, http://0.0.0.0:8787
server/ingest-log/            One JSON file per ingested video (gitignored, bind-mounted from container)
server/transcript/            Python fallback (currently disabled in code)
sync-userscript.sh            Copy userscript to Mac extension container
```

---

## Non-technical summary

**What we built.** A browser extension on Safari (Mac + iPhone) that adds a
small "brainrot score" badge 0-100 to every YouTube video. It works by
having each user's browser grab the video's transcript directly from
YouTube, sending it to a small server, and asking an AI model to rate it.

**Why this shape is close to a real product.** Three architectural choices
are what a real version would look like:

1. Each user's own browser fetches the transcript from their own home
   internet. YouTube aggressively blocks servers that scrape at volume, so
   this is the only pattern that scales.
2. The AI model is too big to ship in a browser extension (~7 GB), so
   scoring lives on a server. That is what a real product would do.
3. The user experience is end-to-end: open a video, see a score.

**Limitations of what we tested.**

- Transcript only. A lot of brainrot is *visual* (jumpcuts, overlay text,
  subway-surfers backgrounds, exaggerated faces). A calm narration over
  chaotic visuals still scores low.
- Videos without captions score nothing. We would need audio transcription
  (Whisper) to cover them.
- Install on iOS is five manual steps. Not shippable to normal users.
- AI scores are not consistent run-to-run - same video might score 22, 28,
  25. Fine for a badge, not for hard blocking.
- We inspected 5-ish videos by hand. No labeled accuracy measurement.

**What is needed to ship a real product.**

- Convert the userscript into a proper Safari App Store extension (wrapped
  in a macOS/iOS container app, Apple review).
- Cache scores keyed by video ID so repeat viewers do not re-score. Cuts
  LLM cost roughly 90%.
- Visual scoring: sample a handful of video frames, detect overlay text,
  fast cuts, subway-surfers-style split screens.
- Whisper fallback for videos without captions.
- User controls: threshold slider, feedback ("this was wrong"), per-channel
  trust.
- Real blocking UI, not just a score. Blur / skip / remove from Up Next.

**Key untested risks.**

1. **Scale.** We tested with one user. If thousands of browsers all send the
   ANDROID-client trick simultaneously, YouTube may detect the pattern and
   start blocking. Unknown until a real user base exists.
2. **Accuracy.** No labeled validation set. The scores "feel right" on
   hand-picked examples - not a measurement.
3. **Latency.** LLM took 7s on a long transcript. Users will not wait 7s
   every video. Need a faster/cheaper model or aggressive caching.
4. **YouTube breaking the trick.** The ANDROID impersonation works today,
   but Google tightens it every few months. Production needs a monitored
   fallback strategy (DOM scrape, paid Data API, etc.).
5. **Apple extension review.** Extensions that inject overlays on other
   sites get extra scrutiny. Never submitted.
6. **iOS overlay rendering.** Data pipeline round-trips to/from iPhone
   confirmed. Mobile YouTube player DOM differs from desktop and the badge
   element may attach to a player element that later re-mounts, leaving the
   badge orphaned. Needs a mobile-specific rendering path.
