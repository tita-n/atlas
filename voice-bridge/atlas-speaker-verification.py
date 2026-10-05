#!/usr/bin/env python3
"""Wyoming speaker-verification bridge for Atlas.

SpeechBrain's ECAPA-TDNN has no Wyoming server and no maintained Node.js
binding, so Atlas ships this small bridge. It speaks the Wyoming protocol on
one side and SpeechBrain on the other, and returns the raw 192-dimensional
embedding as JSON in a `transcript` event.

Scoring, thresholds, and the enrolled voiceprint all stay inside the Atlas
process: this service never receives or stores the enrolled voiceprint, so a
compromised bridge cannot forge an identity, only return a measurement.

Protocol (see https://github.com/OHF-Voice/wyoming):
    <- describe
    -> info
    <- transcribe
    <- audio-start
    <- audio-chunk  (raw PCM)
    <- audio-stop
    -> transcript    (text is a JSON array of floats)

Run:
    python3 atlas-speaker-verification.py --uri tcp://127.0.0.1:10401

Requires: speechbrain, torch, numpy.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import urllib.parse
from typing import Any

import numpy as np

LOGGER = logging.getLogger("atlas-speaker-verification")

MODEL_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
SAMPLE_RATE = 16_000


async def read_exactly(reader: asyncio.StreamReader, count: int) -> bytes | None:
    """Read exactly ``count`` bytes, or return None on clean EOF."""
    if count == 0:
        return b""
    try:
        return await reader.readexactly(count)
    except asyncio.IncompleteReadError as exc:
        # A partial read at EOF is a protocol error, not a clean close.
        if exc.partial:
            raise ConnectionError("truncated Wyoming frame") from exc
        return None


async def read_event(reader: asyncio.StreamReader) -> dict[str, Any] | None:
    """Read one Wyoming frame: header line, extra JSON, then binary payload."""
    header_line = await reader.readline()
    if header_line == b"":
        return None
    try:
        header = json.loads(header_line.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("malformed Wyoming header") from exc

    data: dict[str, Any] = header.get("data") or {}
    data_length = int(header.get("data_length") or 0)
    payload_length = int(header.get("payload_length") or 0)

    if data_length > 0:
        extra = await read_exactly(reader, data_length)
        if extra is None:
            return None
        data.update(json.loads(extra.decode("utf-8")))

    payload = b""
    if payload_length > 0:
        payload = await read_exactly(reader, payload_length) or b""
        data["_payload"] = payload

    return {"type": header.get("type"), "data": data}


async def write_event(
    writer: asyncio.StreamWriter, event_type: str, data: dict[str, Any] | None = None
) -> None:
    payload = json.dumps({"type": event_type, "data": data or {}}) + "\n"
    writer.write(payload.encode("utf-8"))
    await writer.drain()


class Embedder:
    """Lazily loads ECAPA-TDNN so a missing dependency fails fast and loudly."""

    def __init__(self) -> None:
        self._model: Any = None

    def load(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from speechbrain.inference.speaker import SpeakerRecognition
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "speechbrain is not installed. Run: pip install speechbrain torch"
            ) from exc
        LOGGER.info("loading %s", MODEL_SOURCE)
        self._model = SpeakerRecognition.from_hparams(
            source=MODEL_SOURCE, savedir="/tmp/atlas-speaker-verification"
        )
        return self._model

    def embed(self, pcm: bytes) -> list[float]:
        """Return the 192-d ECAPA embedding for signed 16-bit mono PCM."""
        model = self.load()
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size == 0:
            return []
        with torch_no_grad():
            embedding = model.encode_batch(torch_from(samples))
        vector = embedding.squeeze().cpu().numpy().astype(float)
        return [float(value) for value in vector]


def torch_from(samples: np.ndarray) -> Any:
    import torch

    return torch.from_numpy(samples).unsqueeze(0)


def torch_no_grad() -> Any:
    import torch

    return torch.no_grad()


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    embedder: Embedder,
) -> None:
    audio = bytearray()
    try:
        while True:
            event = await read_event(reader)
            if event is None:
                break
            kind = event["type"]
            data = event["data"]

            if kind == "describe":
                await write_event(
                    writer,
                    "info",
                    {
                        "asr": {
                            "models": [
                                {
                                    "name": MODEL_SOURCE,
                                    "languages": ["en"],
                                    "installed": True,
                                    "attribution": {
                                        "name": "SpeechBrain",
                                        "url": "https://github.com/speechbrain/speechbrain",
                                    },
                                    "description": "ECAPA-TDNN speaker embedding",
                                }
                            ]
                        }
                    },
                )
            elif kind == "transcribe":
                audio = bytearray()
            elif kind == "audio-start":
                audio = bytearray()
            elif kind == "audio-chunk":
                payload = data.get("_payload")
                if payload:
                    audio.extend(payload)
            elif kind == "audio-stop":
                vector = await asyncio.to_thread(embedder.embed, bytes(audio))
                await write_event(
                    writer, "transcript", {"text": json.dumps(vector)}
                )
                audio = bytearray()
            else:
                # Unknown events are dropped, per the Wyoming specification.
                LOGGER.debug("ignoring event %s", kind)
    except (ConnectionError, ValueError) as exc:
        LOGGER.warning("client error: %s", exc)
    finally:
        writer.close()


async def run(uri: str) -> None:
    parsed = urllib.parse.urlparse(uri)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 10401

    embedder = Embedder()
    # Fail before accepting connections, so Atlas gets a clear error.
    embedder.load()

    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, embedder), host, port
    )
    LOGGER.info("listening on %s:%s", host, port)
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--uri",
        default="tcp://127.0.0.1:10401",
        help="TCP endpoint to bind. Keep this on loopback: the protocol has no auth.",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        asyncio.run(run(args.uri))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
