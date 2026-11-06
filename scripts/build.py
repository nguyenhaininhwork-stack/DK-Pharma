#!/usr/bin/env python3
"""Đóng gói web để đưa lên hosting.

- Chép các file của web vào thư mục _site/
- Với mỗi gói trong courses/ (file .zip hoặc thư mục đã giải nén có imsmanifest.xml):
  giải nén vào _site/courses/<slug>/ và đọc tên khoá học, số bài từ imsmanifest.xml
- Tạo _site/courses.json là danh mục khoá học cho trang chủ

Chạy: python3 scripts/build.py
"""
import json
import re
import shutil
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
SRC_COURSES = ROOT / "courses"
OUT = ROOT / "_site"
SITE_FILES = ["index.html", "admin.html", "admin.js", "style.css", "app.js", "scorm-api.js", "sw.js", "vendor"]


def slugify(name: str) -> str:
    s = name.replace("đ", "d").replace("Đ", "D")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "khoa-hoc"


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def kids(el, name):
    return [c for c in el if local(c.tag) == name]


def read_manifest(xml_bytes: bytes):
    root = ET.fromstring(xml_bytes)
    text = xml_bytes.decode("utf-8", "ignore")
    version = "1.2"
    for md in kids(root, "metadata"):
        for sv in kids(md, "schemaversion"):
            if re.search(r"2004|CAM 1\.3", sv.text or "", re.I):
                version = "2004"
    if "adlcp_v1p3" in text:
        version = "2004"

    title, lessons = None, 0
    orgs_el = next(iter(kids(root, "organizations")), None)
    if orgs_el is not None:
        orgs = kids(orgs_el, "organization")
        default = orgs_el.get("default")
        org = next((o for o in orgs if o.get("identifier") == default), orgs[0] if orgs else None)
        if org is not None:
            t = next(iter(kids(org, "title")), None)
            title = (t.text or "").strip() if t is not None else None
            lessons = sum(1 for e in org.iter() if local(e.tag) == "item" and e.get("identifierref"))
    return title, version, max(lessons, 1)


def safe_extract(zf: zipfile.ZipFile, dest: Path):
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if info.is_dir() or name.startswith("__MACOSX/"):
            continue
        parts = PurePosixPath(name).parts
        if any(p in ("..", "") for p in parts) or name.startswith("/"):
            print(f"  ! bỏ qua đường dẫn không an toàn: {name}")
            continue
        target = dest.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)


def find_manifest(folder: Path):
    found = [p for p in folder.rglob("*") if p.name.lower() == "imsmanifest.xml" and "__MACOSX" not in p.parts]
    return min(found, key=lambda p: len(p.parts)) if found else None


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for f in SITE_FILES:
        src = ROOT / f
        if src.is_dir():
            shutil.copytree(src, OUT / f)
        else:
            shutil.copy2(src, OUT / f)

    # Gom các gói: file .zip, thư mục, hoặc file zip lớn bị chia nhỏ "<tên>.zip.part001", ".part002"...
    sources = {}  # tên gói -> ("zip", path) | ("dir", path) | ("parts", [paths])
    for p in (SRC_COURSES.iterdir() if SRC_COURSES.exists() else []):
        if p.name.startswith("."):
            continue
        m = re.match(r"^(.+\.zip)\.part(\d+)$", p.name, re.I)
        if m and p.is_file():
            sources.setdefault(m.group(1), ("parts", []))[1].append(p)
        elif p.is_file() and p.suffix.lower() == ".zip":
            sources[p.name] = ("zip", p)
        elif p.is_dir():
            sources[p.name] = ("dir", p)

    catalog, used = [], set()
    tmp_zip = ROOT / "_joined.zip"
    for name in sorted(sources, key=str.lower):
        kind, src = sources[name]
        base = name[:-4] if kind != "dir" else name
        slug = slugify(base)
        while slug in used:
            slug += "-2"
        used.add(slug)
        dest = OUT / "courses" / slug
        print(f"• {name} -> courses/{slug}/" + (f" (ghép {len(src)} phần)" if kind == "parts" else ""))
        try:
            if kind == "parts":
                src.sort(key=lambda p: int(re.search(r"(\d+)$", p.name).group(1)))
                with open(tmp_zip, "wb") as out:
                    for part in src:
                        with open(part, "rb") as inp:
                            shutil.copyfileobj(inp, out)
                src = tmp_zip
            if kind == "dir":
                shutil.copytree(src, dest)
            else:
                with zipfile.ZipFile(src) as zf:
                    safe_extract(zf, dest)
            tmp_zip.unlink(missing_ok=True)
            manifest = find_manifest(dest)
            if not manifest:
                raise ValueError("không có imsmanifest.xml — không phải gói SCORM")
            title, version, lessons = read_manifest(manifest.read_bytes())
        except Exception as e:  # noqa: BLE001
            print(f"  ! LỖI, bỏ qua gói này: {e}")
            shutil.rmtree(dest, ignore_errors=True)
            tmp_zip.unlink(missing_ok=True)
            continue
        catalog.append({
            "slug": slug,
            "source": name,
            "title": title or base,
            "version": version,
            "lessons": lessons,
            "manifestPath": manifest.relative_to(dest).as_posix(),
        })
        print(f"  ✓ {title or base} (SCORM {version}, {lessons} bài)")

    (OUT / "courses.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nXong: {len(catalog)} khoá học -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
