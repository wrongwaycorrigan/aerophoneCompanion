"""Write app/zen.js: the AE-20 -> ZENOLOGY tone layout (from zen_spec.json) and a blank ZENOLOGY tone
record and file header (from a ZENOLOGY export of an empty user bank), so the app can save a tone as a bank."""
import json, sys, zlib
spec_f, blank_bank, out = sys.argv[1:4]
spec = json.load(open(spec_f))
d = open(blank_bank, 'rb').read(); raw = zlib.decompress(d[0x60:])
size = int.from_bytes(raw[8:12], 'little'); count = int.from_bytes(raw[12:16], 'little')
blank = raw[0x20:0x20 + size]
assert all(raw[0x20 + i * size:0x20 + (i + 1) * size] == blank for i in range(count)), 'bank must be empty'
nz = [[i, b] for i, b in enumerate(blank) if b]
compact = {k: [v['copies'], v['stride'], v['base'], [[f['ae'], f['size'], f['centre'], f['pos'], f['w'], int(f['signed'])] for f in v['fields']]] for k, v in spec.items()}
js = ('// ZENOLOGY tone bank layout, worked out by comparing the same tone read from an AE-20 and exported from ZENOLOGY.\n'
      '// blocks: name -> [copies, distance between copies, first byte, [[AE offset, AE size, centre, byte, width, signed]]]\n'
      f'window.ZEN = {{ recSize: {size}, count: {count}, head: {json.dumps(list(d[:0x60]))}, svd: {json.dumps(list(raw[:0x20]))},\n'
      f'  blank: {json.dumps(nz, separators=(",", ":"))},\n  blocks: {json.dumps(compact, separators=(",", ":"))} }};\n')
open(out, 'w').write(js); print('wrote', out, len(js), 'bytes;', len(nz), 'non-zero blank bytes')
