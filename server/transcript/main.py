import sys
import json
from youtube_transcript_api import YouTubeTranscriptApi


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing videoId"}))
        sys.exit(1)
    video_id = sys.argv[1]
    try:
        api = YouTubeTranscriptApi()
        transcript = api.fetch(video_id)
        segments = [
            {"tStart": s.start, "dur": s.duration, "text": s.text}
            for s in transcript
        ]
        print(json.dumps({
            "ok": True,
            "segments": segments,
            "language": getattr(transcript, "language_code", None),
        }))
    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": f"{type(e).__name__}: {str(e)[:300]}",
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
