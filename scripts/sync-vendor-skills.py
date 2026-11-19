#!/usr/bin/env python3
"""Copy the built full-dsh skill payload into the application image."""

import argparse
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="vendor/legal-agent-skills/dist")
    parser.add_argument("--target", type=Path, default=ROOT / "skills" / "vendor")
    args = parser.parse_args()
    source = args.source.resolve()
    target = args.target.resolve()
    manifest = source / "runtime-manifest.json"
    if not manifest.is_file():
        raise SystemExit(f"缺少运行清单：{manifest}")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    enabled = [skill for skill in data.get("skills", []) if skill.get("runtimeEnabled")]
    if not enabled or len(data.get("excludedSkills", [])) != 12:
        raise SystemExit("full-dsh skill 清单不符合 58 个启用 / 12 个排除的策略")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    # Copy only runtime-enabled skill directories. The excluded 12 skills must
    # not be present in the application image, even as dormant scripts or
    # references that a full-dsh task could discover through its shell.
    for item in enabled:
        item_source = source / item["path"]
        if not item_source.is_dir():
            raise SystemExit(f"缺少启用 skill 目录：{item_source}")
        shutil.copytree(item_source, target / item["path"])
    manifest_out = {**data, "skills": enabled}
    (target / "runtime-manifest.json").write_text(json.dumps(manifest_out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"同步 full-dsh skills：启用 {len(enabled)} 个，物理排除 {len(data['excludedSkills'])} 个")


if __name__ == "__main__":
    main()
