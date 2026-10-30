#!/usr/bin/env python3
"""Write app/version.js: the version number plus a build code calculated from the app's own files.

The build code is the first 7 hex digits of a SHA-1 over app.js, app.css, index.html and data.js,
so any change gives a new code and identical files always give the same one.
usage: python3 stamp.py <app folder> [version]
"""
import datetime, hashlib, os, sys
app = sys.argv[1]
version = sys.argv[2] if len(sys.argv) > 2 else '0.9.0'
h = hashlib.sha1()
for f in ('app.js', 'app.css', 'index.html', 'data.js', 'zen.js'):
    h.update(f.encode()); h.update(open(os.path.join(app, f), 'rb').read())
build = h.hexdigest()[:7]
date = datetime.date.today().isoformat()
open(os.path.join(app, 'version.js'), 'w').write(f"window.AE_VERSION = {{ version: '{version}', build: '{build}', date: '{date}' }};\n")
print(f'v{version} · {build} ({date})')
