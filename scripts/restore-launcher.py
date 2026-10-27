#!/usr/bin/env python3
"""把启动图标还原成 1.17.0 时期的绿色日历版本。

1.18.0 为了让 ColorOS 通知卡片左侧显示北邮校徽，换掉了 launcher（那个位置取的是
应用图标，不是通知小图标）。原来的绿色日历图标在 `.assets/launcher-backup/` 里
留了份 5 个密度的备份 —— 本项目没有 git，删掉就真没了，所以单独存档。

用法：
  python scripts/restore-launcher.py          # 还原绿色日历
  python scripts/make-crest-icon.py           # 再改回校徽
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / '.assets/launcher-backup'

DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']


def main():
    if not BACKUP.is_dir():
        print(f'备份目录不存在：{BACKUP}', file=sys.stderr)
        return 1
    done = 0
    for dens in DENSITIES:
        src = BACKUP / f'mipmap-{dens}-v4.png'
        if not src.exists():
            print(f'缺少 {src}', file=sys.stderr)
            continue
        dst_dir = ROOT / f'android/res/mipmap-{dens}'
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst_dir / 'ic_launcher.png')
        done += 1
    print(f'已还原 {done} 个密度的启动图标（绿色日历）')
    print('记得重新打包：node scripts/build-android.mjs')
    return 0 if done == len(DENSITIES) else 1


if __name__ == '__main__':
    sys.exit(main())
