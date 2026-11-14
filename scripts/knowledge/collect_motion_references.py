"""Collect read-only video evidence; never infer or approve motion rules.

Requires the repository's ffmpeg-static and Pillow environment. Review the
inventory/contact sheets separately before curating runtime reference records.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import subprocess

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "node_modules/ffmpeg-static/ffmpeg"
EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v"}


def sha(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(ffmpeg: Path, args: list[str]) -> str:
    result = subprocess.run([str(ffmpeg), "-hide_banner", "-nostdin", *args],
                            capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return result.stderr


def probe(ffmpeg: Path, file: Path) -> dict:
    output = run(ffmpeg, ["-copyts", "-i", str(file), "-map", "0:v:0", "-vf", "showinfo",
                          "-frames:v", "1", "-an", "-f", "null", "-"])
    duration = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", output)
    dimensions = re.search(r"\bs:(\d+)x(\d+)\b", output)
    rate = re.search(r"frame_rate: (\d+)/(\d+)", output)
    pts = re.search(r"pts_time:([0-9.e+-]+)", output)
    if not all((duration, dimensions, rate, pts)):
        raise ValueError("Could not determine duration, display dimensions, frame rate and first source PTS")
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    fps = Fraction(int(rate[1]), int(rate[2]))
    if seconds <= 0 or fps <= 0:
        raise ValueError("Invalid video duration/frame rate")
    return {"durationSeconds": seconds, "width": int(dimensions[1]), "height": int(dimensions[2]),
            "fpsRational": str(fps), "fps": float(fps), "firstSourcePtsSeconds": float(pts[1]),
            "audioStreams": len(re.findall(r"Stream #.*Audio:", output))}


def sheets(files: list[Path], times: list[float], directory: Path) -> list[dict]:
    results = []
    for start in range(0, len(files), 20):
        subset = files[start:start + 20]
        sheet = Image.new("RGB", (1280, 220 * ((len(subset) + 3) // 4)), "#171717")
        draw = ImageDraw.Draw(sheet)
        for i, file in enumerate(subset):
            with Image.open(file) as image:
                image = image.convert("RGB")
                image.thumbnail((310, 190))
                x, y = i % 4 * 320, i // 4 * 220
                sheet.paste(image, (x + (320 - image.width) // 2, y + 24))
                draw.text((x + 6, y + 5), f"{times[start+i]:.4f}s", fill="white")
        target = directory / f"contact-{start // 20 + 1:02}.jpg"
        sheet.save(target, quality=94)
        results.append({"path": target.name, "sha256": sha(target), "width": sheet.width,
                        "height": sheet.height, "timestampsSeconds": times[start:start + len(subset)]})
    return results


def extract(ffmpeg: Path, source: Path, directory: Path, meta: dict,
            start: float, end: float, fps: float, max_frames: int) -> dict:
    directory.mkdir()
    offset = meta["firstSourcePtsSeconds"]
    # select retains original frames/PTS: unlike the fps filter it never fabricates duplicates.
    selection = (f"between(t,{start+offset:.9f},{end+offset:.9f})*"
                 f"(isnan(prev_selected_t)+gte(t-prev_selected_t,{1/fps-1e-7:.9f}))")
    output = run(ffmpeg, ["-copyts", "-i", str(source), "-map", "0:v:0", "-an", "-vf",
                         f"select='{selection}',scale=640:640:force_original_aspect_ratio=decrease,trim=end_frame={max_frames},showinfo",
                         "-vsync", "vfr", "-frames:v", str(max_frames), "-q:v", "3",
                         str(directory / "frame-%04d.jpg")])
    time_base = re.search(r"config in time_base: (\d+)/(\d+)", output)
    source_pts = [int(t) for t in re.findall(r"\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:", output)]
    if not time_base:
        raise ValueError("Missing source frame time base")
    tick = Fraction(int(time_base[1]), int(time_base[2]))
    pts = [float(n * tick) for n in source_pts]
    files = sorted(directory.glob("frame-*.jpg"))
    if not files or len(pts) != len(files):
        raise ValueError("Frame count and source PTS evidence do not agree")
    times = [round(t-offset, 9) for t in pts]
    return {"requestedWindowSeconds": [start, end], "requestedSampleFps": fps,
            "timestampsSeconds": times, "sourcePtsSeconds": pts, "sourcePts": source_pts,
            "sourceTimeBase": str(tick), "frameCount": len(files),
            "possiblyTruncatedAtFrameLimit": len(files) == max_frames,
            "timeBasis": "Original selected frame PTS; clip-relative time subtracts first source PTS",
            "frames": [{"path": f.name, "sha256": sha(f)} for f in files],
            "contactSheets": sheets(files, times, directory)}


def collect(source: Path, output: Path, ffmpeg: Path = FFMPEG, sample_fps: float = 1,
            windows: list[dict] | None = None, max_frames: int = 600) -> dict:
    source, output = source.resolve(), output.resolve()
    if not source.is_dir() or output == source or source in output.parents:
        raise ValueError("Source must be a directory; output must be outside it")
    if not 0 < sample_fps <= 60 or not 1 <= max_frames <= 3600:
        raise ValueError("Invalid sampling rate or frame limit")
    files = sorted(p for p in source.iterdir() if p.suffix.lower() in EXTENSIONS and p.is_file())
    if not files or any(p.is_symlink() for p in files):
        raise ValueError("Provide regular video files, without symlinks")
    names = {p.name for p in files}
    windows = windows or []
    for window in windows:
        if (set(window) != {"file", "start", "end", "fps"} or window["file"] not in names
                or not 0 <= window["start"] < window["end"] or not 0 < window["fps"] <= 60):
            raise ValueError("Invalid dense window; use exact source filename and valid seconds/fps")
    output.mkdir(parents=True, exist_ok=False)  # Never overwrite a previous review collection.
    inventory = {"version": "motion-reference-collection/1", "createdAt": datetime.now(timezone.utc).isoformat(),
                 "sourceDirectory": str(source), "originalsReadOnly": True, "status": "collecting", "records": []}
    def save():
        temp = output / "inventory.tmp.json"
        temp.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
        temp.replace(output / "inventory.json")
    save()
    for file in files:
        digest = sha(file)
        record = {"id": "motion-" + digest[:16], "originalName": file.name, "originalPath": str(file),
                  "originalSha256": digest, "byteLength": file.stat().st_size, "reviewStatus": "NOT_REVIEWED",
                  "observations": [], "patterns": [], "authority": "unclassified-source", "windows": []}
        inventory["records"].append(record)
        try:
            meta = probe(ffmpeg, file)
            record.update(meta)
            # Different filenames may contain identical video bytes; retain provenance independently.
            folder = output / f"{len(inventory['records']):03}-{record['id']}"
            folder.mkdir()
            record["overview"] = {"directory": str((folder / "overview").relative_to(output)),
                                  **extract(ffmpeg, file, folder / "overview", meta, 0,
                                            meta["durationSeconds"], sample_fps, max_frames)}
            for i, window in enumerate(w for w in windows if w["file"] == file.name):
                if window["end"] > meta["durationSeconds"]:
                    raise ValueError("Dense window exceeds source duration")
                target = folder / f"dense-{i+1:02}"
                record["windows"].append({"directory": str(target.relative_to(output)),
                                          **extract(ffmpeg, file, target, meta, window["start"],
                                                    window["end"], window["fps"], max_frames)})
            if sha(file) != digest:
                raise ValueError("Source changed during collection; evidence requires recollection")
            record["collectionStatus"] = "collected"
        except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            record["collectionStatus"] = "failed"
            record["error"] = str(error)
        save()
    inventory["status"] = "completed" if all(r["collectionStatus"] == "collected" for r in inventory["records"]) else "partial"
    save()
    return inventory


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, default=FFMPEG)
    parser.add_argument("--sample-fps", type=float, default=1)
    parser.add_argument("--windows", type=Path, help='JSON array: [{"file":"clip.mp4","start":0,"end":1.2,"fps":15}]')
    parser.add_argument("--max-frames", type=int, default=600)
    args = parser.parse_args()
    result = collect(args.source, args.output, args.ffmpeg.resolve(), args.sample_fps,
                     json.loads(args.windows.read_text()) if args.windows else [], args.max_frames)
    print(json.dumps({"status": result["status"], "videos": len(result["records"]),
                      "inventory": str(args.output / "inventory.json")}, ensure_ascii=False))
    raise SystemExit(0 if result["status"] == "completed" else 1)
