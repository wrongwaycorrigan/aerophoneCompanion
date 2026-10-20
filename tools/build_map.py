"""Build the app's parameter map (roots/tables) from the parsed MIDI Implementation.
Block names are the keys used by .aezl scene files, so they are kept as the file format expects."""
import re, json, sys

SIZES = {'INTEGER1x1': 65536, 'INTEGER1x2': 65537, 'INTEGER1x3': 65538, 'INTEGER1x4': 65539, 'INTEGER1x5': 65540,
         'INTEGER1x6': 65541, 'INTEGER1x7': 65542, 'INTEGER2x4': 65543, 'INTEGER2x7': 65547, 'INTEGER4x4': 65544,
         'INTEGER8x4': 65545, 'PADDING': 131072}
KEYS = ['X', 'C1', 'C2', 'C3', 'C4', 'C5', 'Tc', 'Ta']

def block_name(prefix, desc):
    """Our short block names for each documented sub-table (prefix: Sys / Perf / PCMEX)."""
    d = desc.replace('(Only for AE-30)', '').strip()
    n = re.search(r'\((\d+)\)', d)
    num = str(int(n.group(1))) if n else None
    kind = 'midi' if 'MIDI OUT' in d else 'as'
    m = re.match(r'^(S1|S2) Button', d)
    if m: return f'{prefix}_{kind}_sw_{m.group(1)[1]}'
    m = re.match(r'^Side Key \((\w+)\)', d)
    if m: return f'{prefix}_{kind}_key_{KEYS.index(m.group(1)) + 1}'
    for word, nm in (('Breath', 'breath'), ('Thumb Pad', 'pad'), ('Motion', 'motion')):
        if d.startswith(word): return f'{prefix}_{kind}_{nm}_1'
    for word, nm in (('Bite', 'bite'), ('Wheel', 'wheel')):
        if d.startswith(word): return f'{prefix}_{kind}_{nm}_{1 if "(Down)" in d else 2}'
    simple = {'System Common': 'Sys_common', 'Scene Common': 'Perf_common', 'Scene Chorus': 'Perf_cho', 'Scene Delay': 'Perf_dly',
              'Scene Reverb': 'Perf_rev', 'Scene IFX': 'Perf_ifx', 'common': 'PCMEX_common', 'mfx': 'PCMEX_mfx', 'pmt': 'PCMEX_pmt',
              'synCom': 'PCMEX_synCom', 'synPmt': 'PCMEX_synPmt'}
    if d in simple: return simple[d]
    for start, nm in (('Fingering Setting', 'Sys_fingering'), ('Favorite', 'Sys_favorite'), ('Scene Tone', 'Perf_part'),
                      ('Scene EQ', 'Perf_eq'), ('Scene MFX', 'Perf_mfx'), ('MIDI Control Mode', 'Perf_midi_ctrl')):
        if d.startswith(start): return f'{nm}_{num}'
    m = re.match(r'^(ptl\w*|synPtl) (\d)$', d)
    if m: return f'PCMEX_{m.group(1)}_{m.group(2)}'
    raise ValueError('no block name for ' + desc)

ROOTS = [('System', 'System', 'System'), ('stp', 'Setup', None), ('Temporary_Scene', 'Temporary Scene', 'Scene')]
ROOTS += [(f'Temporary_Tone_PCM_({i})', f'Temporary Tone PCM ({i})', 'Tone') for i in range(1, 5)]
PREFIX = {'System': 'Sys', 'Scene': 'Perf', 'Tone': 'PCMEX'}

NUM = r'[-+]?\d+(?:\.\d+)?'
def disp_range(t):
    """'-24.0 - +24.0 [dB]', 'L64 - 63R', '1 - 16' -> (low, high, decimal places) or None"""
    t = re.sub(r'\[.*?\]|\(.*?\)', '', t).strip()
    m = re.match(r'^(L)?([-+]?\d+(?:\.(\d+))?)\s*-\s*([-+]?\d+(?:\.(\d+))?)(R)?\s*(?:dB|cent)?$', t)
    if not m: return None
    a, b = float(m.group(2)), float(m.group(4))
    if m.group(1): a = -a
    return a, b, len(m.group(3) or m.group(5) or '')

def leaf(e):
    rows, bits = e['rows'], e['bits']
    if rows == 1: s = SIZES['INTEGER1x%d' % max(1, bits)]
    elif bits <= 4: s = SIZES['INTEGER%dx4' % rows]
    else: s = SIZES['INTEGER%dx7' % rows]
    name = e['name'] or '(reserved)'
    out = {'n': name, 'a': e['off'], 's': s}
    lo, hi = e['raw'] if e['raw'] else (0, (1 << bits) - 1 if rows == 1 else 0)
    mn, mx, o = lo, hi, 0
    r = disp_range(e['disp'][0]) if e['disp'] else None
    if r and hi > lo:
        a, b, places = r
        k = 10 ** places
        a, b = round(a * k), round(b * k)
        if b - a == hi - lo and a < 0: mn, mx, o = a, b, lo - a   # centred values are stored with an offset
    elif e['disp'] and 'Center' in ' '.join(e['disp']) and (lo, hi) == (0, 127):
        mn, mx, o = -64, 63, 64                                      # L64 .. Center .. 63R
    if mn: out['mn'] = mn
    out['mx'] = mx
    if o: out['o'] = o
    return out

def build(doc):
    maps, leaves = doc['maps'], doc['leaves']
    tables, ids = [], {}
    def table_for(key, kind):          # kind: ('leaf', name) | ('map', name)
        if key in ids: return ids[key]
        ids[key] = len(tables); tables.append(None)
        if kind == 'leaf': tables[ids[key]] = [leaf(e) for e in leaves[key[1]]]
        else:
            prefix = PREFIX[key[1]]
            tables[ids[key]] = [{'n': block_name(prefix, d), 'a': off, 'c': table_for(('leaf', sub) if sub in leaves else ('map', sub), 'leaf' if sub in leaves else 'map')}
                                for off, d, sub in maps[key[1]]]
        return ids[key]
    top = {d: off for off, d, sub in maps['_top']}
    roots = []
    for name, desc, sub in ROOTS:
        sub = sub or desc
        roots.append({'n': name, 'a': top[desc], 'c': table_for(('leaf', sub) if sub in leaves else ('map', sub), 'leaf' if sub in leaves else 'map')})
    return {'roots': roots, 'tables': tables}

if __name__ == '__main__':
    doc = json.load(open(sys.argv[1]))
    json.dump(build(doc), open(sys.argv[2], 'w'))
