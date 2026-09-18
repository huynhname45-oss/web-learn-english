"""Local launcher for whole-utterance online neural speech; never executes text."""
import asyncio
import json
import sys
import edge_tts

def rate_percent(rate):
    percent = round((float(rate) - 1) * 100)
    return f"{percent:+d}%"

async def main():
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if data.get("list"):
        voices = await edge_tts.list_voices()
        sys.stdout.write(json.dumps([v["ShortName"] for v in voices]))
        return
    voice = data["voice"]
    if not voice.startswith(("en-US-", "en-GB-", "en-AU-")):
        raise ValueError("Unsupported voice")
    # One continuous request preserves coarticulation and sentence prosody.
    speech = edge_tts.Communicate(
        data["text"],
        voice,
        rate=rate_percent(data.get("rate", 1)),
    )
    async for chunk in speech.stream():
        if chunk["type"] == "audio":
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()
            emitted = True
    if not locals().get("emitted"):
        raise RuntimeError("No speech audio returned")

if __name__ == "__main__":
    asyncio.run(main())
