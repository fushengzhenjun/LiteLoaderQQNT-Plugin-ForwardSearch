# 生成给用户分发的 zip（带一层文件夹，解压出来不会散一地）
import os
import shutil
import zipfile

SRC = 'files'
TOPFOLDER = '合并转发搜索'
OUT = 'ForwardSearch-Folder.zip'

if os.path.exists(OUT):
    os.remove(OUT)

SEP = chr(92)
count = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
        for fn in files:
            if fn.startswith('.') or fn.endswith(('.bak', '.orig', '.tmpbak', '.log')):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, SRC).replace(SEP, '/')
            z.write(full, TOPFOLDER + '/' + rel)
            count += 1

print('%s: %d KB, %d files' % (OUT, round(os.path.getsize(OUT) / 1024), count))
with zipfile.ZipFile(OUT) as z:
    print('first 6:', z.namelist()[:6])
