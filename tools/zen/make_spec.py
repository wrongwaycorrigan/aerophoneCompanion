"""Build the AE-20 -> ZENOLOGY tone spec from an aligned pair (tone.json from the app + ZENOLOGY bank with
the same tone). Writes zen_spec.json: per block, where its first copy starts, the distance between copies,
and for each setting its byte position, width and whether it is stored signed (centre = 0)."""
import json, sys, zlib
sys.path.insert(0, __file__.rsplit('/', 1)[0]); import align as A
tone, bank, slot, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
ae = json.load(open(tone))['blocks']; rec = A.zen_records(bank)[slot - 1]
raw = lambda b: [int(x, 16) for x in ae[b].split()]
# block: (copies, distance between copies, search window for the first copy)
LAYOUT = {'common': (1, 0, (0x08, 0x18)), 'mfx': (1, 0, (0x48, 0x58)), 'pmt': (1, 0, (0xa0, 0xa8)),
          'ptl': (4, 124, (0xd0, 0xe0)), 'ptlFenv': (4, 24, (0x320, 0x32a)), 'ptlAenv': (4, 16, (0x384, 0x390)),
          'ptlLfo': (4, 104, (0x3a8, 0x3d0)), 'synCom': (1, 0, (0x5a4, 0x5ac)), 'synPtl': (4, 36, (0x5c0, 0x5e4))}
spec = {}
for blk, (n, stride, win) in LAYOUT.items():
    name = blk + ('_1' if n > 1 else '')
    copies = [raw(f'{blk}_{p}' if n > 1 else blk) for p in range(1, n + 1)]
    res, _ = A.align(name, copies, rec, stride, n, win)
    fields = []
    for (nm, a, s, o, mx), pos, w in res:
        if not w or nm in ('(reserved)', 'Reserved', ''): continue
        fields.append({'name': nm, 'ae': a, 'size': s, 'centre': o, 'pos': pos, 'w': w, 'signed': bool(o)})
    base = min(f['pos'] for f in fields)
    spec[blk] = {'copies': n, 'stride': stride, 'base': base, 'fields': [dict(f, pos=f['pos'] - base) for f in fields]}
# the mix table repeats every 12 bytes per partial; the matrix every 12 bytes; zeros let the alignment drift there
def fix_repeat(blk, first_names, step, count, start_rel):
    fs = spec[blk]['fields']
    for k in range(count):
        for j, nm in enumerate(first_names):
            idx = [i for i, f in enumerate(fs) if f['name'] == nm][k]
            fs[idx]['pos'] = start_rel[j] + step * k
pm = ['Partial Switch', 'KeyRange Lower', 'KeyRange Upper', 'KeyFade Lower', 'KeyFade Upper', 'VeloRange Lower', 'VeloRange Upper', 'VeloFade Lower', 'VeloFade Upper']
b = spec['pmt']['base']; fix_repeat('pmt', pm, 12, 4, [0xa8 - b + x for x in (0, 1, 5, 6, 7, 8, 9, 10, 11)])
mx = ['Source', 'Destination 1', 'Sens 1', 'Destination 2', 'Sens 2', 'Destination 3', 'Sens 3', 'Destination 4', 'Sens 4']
b = spec['ptl']['base']; fix_repeat('ptl', mx, 12, 4, [0x114 - b + x for x in range(9)])
for nm, p in (('Damper Free Note', 0x144), ('Stereo Width', 0x145), ('Stereo Detune', 0x146), ('Damper Free Decay Offset', 0x147), ('Wave Tempo Sync', 0x148)):
    [f for f in spec['ptl']['fields'] if f['name'] == nm][0]['pos'] = p - b
# Pitch envelope and partial EQ: placed by hand. EQ from the Funky Bass pair (values match exactly); the pitch
# envelope confirmed with a sweep made in ZENOLOGY (Time4 = 1023 and Level3 = +511 land where expected)
HAND = {'ptlPenv': (4, 24, 0x2c8, [(0, 1), (1, 1), (2, 1), (3, 1), (4, 2), (6, 2), (8, 2), (10, 2),
                                   (12, 2), (14, 2), (16, 2), (18, 2), (20, 2), (22, 1)]),
        'ptlEq': (4, 16, 0x568, [(0, 2), (2, 2), (4, 2), (6, 2), (8, 2), (10, 2), (12, 1), (13, 1)])}
for blk, (n, stride, base, places) in HAND.items():
    E = A.entries(blk + '_1'); assert len(E) == len(places), blk
    spec[blk] = {'copies': n, 'stride': stride, 'base': base, 'fields': [
        {'name': e[0], 'ae': e[1], 'size': e[2], 'centre': e[3], 'pos': p, 'w': w, 'signed': bool(e[3])}
        for e, (p, w) in zip(E, places)]}
json.dump(spec, open(out, 'w'), indent=1)
print({k: (v['base'], v['stride'], len(v['fields'])) for k, v in spec.items()})
