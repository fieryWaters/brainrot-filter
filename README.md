# brainrot-filter

Proof of concept for a YouTube "brainrot score" overlay. A Safari userscript
extracts the full transcript of the current video from the browser, sends it
to a local Node server, which forwards it to a self-hosted LLM for scoring
0-100, and paints the score as a badge on the video player. Runs on Mac and
iPhone over Tailscale.

---

## Architecture

```
[Safari userscript]  --transcript-->  [Mac Node server]  --prompt-->  [spark LLM]
   (Mac or iPhone)      8787                                             11434
      |                                                                   |
      `------------------- score (0-100) <-----------------------------'
```

| Piece               | Where                              | Role                                                                 |
|---------------------|------------------------------------|----------------------------------------------------------------------|
| Userscript          | Safari (Mac + iPhone)              | Reads video metadata, fetches transcript via YouTube InnerTube       |
| Node server         | Mac, bound `0.0.0.0:8787`          | Receives transcript, calls LLM, logs JSON, returns score             |
| Ollama + qwen3.5:9b | `spark` (Linux box on Tailscale)   | Scores a transcript 0-100                                            |
| Tailscale           | All devices                        | Private network glue so the phone reaches the Mac, Mac reaches spark |

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

## Setup

### 1. LLM on spark

Requires Ollama installed and listening on the Tailscale interface:

```
ssh spark 'ollama pull qwen3.5:9b'
```

Verify reachable from the Mac:

```
curl -s http://100.106.166.101:11434/api/tags | head
```

### 2. Node server on the Mac

```
cd server
node index.js
```

Bind is `0.0.0.0:8787` so phones on Tailscale can reach it. Stdlib only, no
npm install. Logs each ingest and writes a full JSON record to
`server/ingest-log/`.

Sanity:

```
curl http://localhost:8787/health
curl http://100.94.9.65:8787/health   # from any tailscale device
```

Tailscale **Shields Up** must be off on the Mac, otherwise incoming tailscale
traffic is silently dropped:

```
/Applications/Tailscale.app/Contents/MacOS/Tailscale set --shields-up=false
```

### 3. Userscript on Mac Safari

After editing `userscript/brainrot.user.js`:

```
./sync-userscript.sh
```

Click the Userscripts toolbar icon in Safari and hit Refresh so the extension
re-scans. The script is hardcoded to `http://100.94.9.65:8787` (Mac's
tailscale IP) so the same script works from Mac and iPhone.

### 4. Userscript on iPhone Safari

1. Install **Userscripts** from the App Store (same dev as the Mac app).
2. Settings -> Safari -> Extensions -> Userscripts -> toggle on, set
   Permissions -> All Websites -> Allow.
3. Open the Userscripts app, tap `+`, paste the contents of
   `userscript/brainrot.user.js`. Save.
4. In Safari, browse to a YouTube video. Badge appears on the player.

### 5. Making iOS airtight (Screen Time lock)

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

To reverse: Settings -> Screen Time -> Content & Privacy Restrictions ->
enter passcode -> revert Web Content to Unrestricted.

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
- Everything is on a private Tailscale network. If the Mac sleeps the phone
  stops getting scores.
- Install on iOS is five manual steps. Not shippable to normal users.
- AI scores are not consistent run-to-run - same video might score 22, 28,
  25. Fine for a badge, not for hard blocking.
- We inspected 5-ish videos by hand. No labeled accuracy measurement.

**What is needed to ship a real product.**

- Convert the userscript into a proper Safari App Store extension (wrapped
  in a macOS/iOS container app, Apple review).
- Move scoring from the home LLM to a cloud-hosted LLM provider (~$0.001
  per video at current prices).
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

---

## Repo layout

```
userscript/brainrot.user.js   Safari Userscripts source of truth
server/index.js               Node server, http://0.0.0.0:8787
server/ingest-log/            One JSON file per ingested video (gitignored)
server/transcript/            Python fallback (currently disabled in code)
sync-userscript.sh            Copy userscript to Mac extension container
```
