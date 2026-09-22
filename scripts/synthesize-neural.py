"""Long-lived neural speech worker.

The parent process sends one JSON request per line. Audio is returned as
base64-encoded JSON-line chunks so the parent can stream it to the browser
without spawning Python for every utterance.
"""
import asyncio
import base64
import io
import json
import os
import sys
import wave
import edge_tts

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

LOCAL_VOICES = {
    "local-af-heart": "af_heart",
    "local-af-bella": "af_bella",
    "local-am-michael": "am_michael",
    "local-am-fenrir": "am_fenrir",
    "local-bf-emma": "bf_emma",
    "local-bf-isabella": "bf_isabella",
    "local-bm-george": "bm_george",
    "local-bm-fable": "bm_fable",
}
_kokoro = None
_kokoro_paths = None

def rate_percent(rate):
    percent = round((float(rate) - 1) * 100)
    return f"{percent:+d}%"

def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def wav_bytes(samples, sample_rate):
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def local_speech(data):
    global _kokoro, _kokoro_paths
    from kokoro_onnx import Kokoro
    import numpy as np

    paths = (data["model_path"], data["voices_path"])
    if _kokoro is None or _kokoro_paths != paths:
        _kokoro = Kokoro(*paths)
        _kokoro_paths = paths
    voice = LOCAL_VOICES[data["voice"]]
    language = "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"
    speed = float(data.get("rate", 1))
    if speed >= 0.5:
        samples, sample_rate = _kokoro.create(
            data["text"], voice=voice, speed=speed, lang=language
        )
    else:
        # Kokoro's graph supports 0.25x natively, although the public helper
        # conservatively validates 0.5x. Keep phoneme duration inside the model
        # instead of stretching a normal recording in the browser.
        phonemes = " ".join(_kokoro.tokenizer.phonemize(data["text"], language).split())
        style = _kokoro.get_voice_style(voice)
        parts = [
            _kokoro._create_audio(batch, style, speed)[0]
            for batch in _kokoro._split_phonemes(phonemes)
        ]
        if not parts:
            raise RuntimeError("No local speech audio returned")
        samples, sample_rate = np.concatenate(parts), 24000
    return wav_bytes(samples, sample_rate)


async def synthesize(data):
    request_id = str(data.get("id", ""))
    try:
        if data.get("list"):
            voices = await edge_tts.list_voices()
            emit({"id": request_id, "type": "voices", "voices": [v["ShortName"] for v in voices]})
            return
        voice = data["voice"]
        if voice in LOCAL_VOICES:
            audio = await asyncio.to_thread(local_speech, data)
            emit({
                "id": request_id,
                "type": "chunk",
                "data": base64.b64encode(audio).decode("ascii"),
            })
            emit({"id": request_id, "type": "done"})
            return
        if not voice.startswith(("en-US-", "en-GB-", "en-AU-")):
            raise ValueError("Unsupported voice")
        # A fresh Communicate instance preserves coarticulation and sentence
        # prosody. The Python process itself remains warm between jobs.
        speech = edge_tts.Communicate(
            data["text"],
            voice,
            rate=rate_percent(data.get("rate", 1)),
        )
        emitted = False
        async for chunk in speech.stream():
            if chunk["type"] == "audio":
                emitted = True
                emit({
                    "id": request_id,
                    "type": "chunk",
                    "data": base64.b64encode(chunk["data"]).decode("ascii"),
                })
        if not emitted:
            raise RuntimeError("No speech audio returned")
        emit({"id": request_id, "type": "done"})
    except Exception as error:
        emit({"id": request_id, "type": "error", "message": str(error)[:500]})


async def main():
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not line:
            return
        try:
            data = json.loads(line.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("Invalid request")
            await synthesize(data)
        except Exception as error:
            emit({"id": "", "type": "error", "message": str(error)[:500]})

if __name__ == "__main__":
    asyncio.run(main())
