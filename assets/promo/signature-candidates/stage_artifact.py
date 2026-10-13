#!/usr/bin/env python3
"""Stage audition.html for publishing as a Claude artifact (the README says
what the published copy holds).

    python3 stage_artifact.py <empty dir> [--running] [--without NAME ...]

--running stages only what the page shows above its older rounds: the newest
round and what is in the running (LIVE in synth_signature.py); --without
leaves the named directions out.

An artifact page is a fragment with nothing above its own folder, so this
writes <dir>/aloud-signature-sounds.html (the page without its html/head/body
wrapper, audition-data.js inlined, the comparison sounds under refs/) beside
every file the page plays, and <dir>/files.json listing them for the publish.
The spectrograms go as JPEG and the scope videos are re-encoded smaller: as
rendered, the set is over what one publish takes. Run synth_signature.py
first; needs ffmpeg."""
import argparse
import json
import os
import re
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('out')
parser.add_argument('--running', action='store_true')
parser.add_argument('--without', nargs='*', default=[])
args = parser.parse_args()
src, out = os.path.dirname(os.path.abspath(__file__)), args.out
repo = os.path.abspath(os.path.join(src, '..', '..', '..'))
shutil.rmtree(out, ignore_errors=True)
for d in ('phone', 'spectrograms', 'audition', 'refs'):
    os.makedirs(os.path.join(out, d))
html = open(os.path.join(src, 'audition.html')).read()
data = open(os.path.join(src, 'audition-data.js')).read()
title = re.search(r'<title>.*?</title>', html, re.S).group(0)
style = re.search(r'<style>.*?</style>', html, re.S).group(0)
body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
page = json.loads(data[data.index('{'):data.rindex('}') + 1])
for part in ('revisions', 'candidates'):
    page[part] = [c for c in page[part] if c['name'] not in args.without
                  and (not args.running or c['name'] in page['live'] or c.get('round') == page.get('fresh'))]
page['live'] = [name for name in page['live'] if name not in args.without]
assert '<script src="audition-data.js"></script>' in body
body = body.replace('<script src="audition-data.js"></script>',
                    '<script>\nwindow.SIGNATURE = ' + json.dumps(page, indent=1) + ';\n</script>')
for old, new in (("'../bowl-candidates/bowl-deep-long.mp3'", "'refs/bowl-deep-long.mp3'"),
                 ("`../../../ts/ui/public/audio/${n}.mp3`", "`refs/${n}.mp3`"),
                 ('-open.png"', '-open.jpg"'), ('-close.png"', '-close.jpg"')):
    assert old in body, old
    body = body.replace(old, new)
assert '../' not in body
open(os.path.join(out, 'aloud-signature-sounds.html'), 'w').write(title + '\n' + style + '\n' + body.strip() + '\n')
names = [c['name'] for c in page['revisions'] + page['candidates']]
files = []
def copy(rel, frm=None):
    shutil.copyfile(frm or os.path.join(src, rel), os.path.join(out, rel)); files.append(rel)
for n in names:
    for k in ('open', 'close'):
        copy(f'{n}-{k}.mp3'); copy(f'phone/{n}-{k}.16k.wav'); copy(f'phone/{n}-{k}.8k.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(src, f'spectrograms/{n}-{k}.png'), '-q:v', '4',
                        os.path.join(out, f'spectrograms/{n}-{k}.jpg')], check=True); files.append(f'spectrograms/{n}-{k}.jpg')
        if any(c['name'] == n and c['drawn'] for c in page['revisions'] + page['candidates']):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(src, f'audition/{n}-{k}-scope.mp4'), '-c:v', 'libx264',
                            '-pix_fmt', 'yuv420p', '-crf', '30', '-preset', 'slow', '-c:a', 'copy', '-movflags', '+faststart',
                            os.path.join(out, f'audition/{n}-{k}-scope.mp4')], check=True); files.append(f'audition/{n}-{k}-scope.mp4')
for f in ('voice.mp3', 'voice.16k.wav', 'voice.8k.wav', 'chime.wav'):
    copy('audition/' + f)
copy('refs/bowl-deep-long.mp3', os.path.join(src, '..', 'bowl-candidates', 'bowl-deep-long.mp3'))
for n in ('bowl', 'rin', 'bike-bell', 'bottle', 'card', 'crow', 'plop', 'poof', 'rattle'):
    copy(f'refs/{n}.mp3', os.path.join(repo, 'ts', 'ui', 'public', 'audio', n + '.mp3'))
json.dump([{'path': f} for f in files], open(os.path.join(out, 'files.json'), 'w'))
total = sum(os.path.getsize(os.path.join(out, f)) for f in files)
print(len(files), 'files,', round(total / 1e6, 1), 'MB; page', os.path.getsize(os.path.join(out, 'aloud-signature-sounds.html')), 'bytes')
