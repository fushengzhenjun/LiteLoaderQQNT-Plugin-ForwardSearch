import os
import zipfile

SRC = 'files'
OUT = 'payload.zip'

if os.path.exists(OUT):
    os.remove(OUT)

SEP = chr(92)  # 反斜杠，避免转义问题

count = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
        for fn in files:
            if fn.startswith('.') or fn.endswith(('.bak', '.orig', '.tmpbak', '.log')):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, SRC)
            arc = rel.replace(SEP, '/')
            z.write(full, arc)
            count += 1

size = os.path.getsize(OUT)
print('payload.zip: %d KB, %d files' % (round(size / 1024), count))
with zipfile.ZipFile(OUT) as z:
    names = z.namelist()
    print('first 6:', names[:6])
