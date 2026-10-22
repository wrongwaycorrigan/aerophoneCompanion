#!/usr/bin/env python3
"""Build app/data.js from Roland's public AE-30/AE-20 documents.

usage: python3 build_data.py <MIDI Implementation.pdf> <Parameter Guide.pdf> <Scene List.pdf> <out data.js>
Needs pdftotext (poppler) and pdfplumber.

  MIDI Implementation  -> the parameter address map, sizes, ranges and choices
  Parameter Guide      -> effect types and each effect's settings; CC names
  Scene List           -> preset categories, tone names and categories
"""
import json, os, re, subprocess, sys, tempfile
import pdfplumber
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import midi_map, build_map, fx_tables, fx_build

midi_pdf, guide_pdf, list_pdf, out = sys.argv[1:5]

def text(pdf):
    return subprocess.check_output(['pdftotext', '-layout', pdf, '-'], stderr=subprocess.DEVNULL).decode('utf-8', 'replace')

# ---------------- parameter map ----------------
tmp = tempfile.mktemp(suffix='.txt'); open(tmp, 'w').write(text(midi_pdf))
maps, leaves = midi_map.parse(tmp); os.unlink(tmp)
doc = {'maps': maps, 'leaves': leaves}

# Settings the instrument has that the document lists as reserved, which the app uses.
EXTRA = {'Scene Part': [{'off': 10, 'rows': 1, 'bits': 1, 'name': 'Follow Tone MFX', 'raw': (0, 1), 'disp': ['Off, On']}]}
for t, es in EXTRA.items():
    for x in es:
        leaves[t] = [e for e in leaves[t] if e['off'] != x['off']] + [x]
        leaves[t].sort(key=lambda e: e['off'])
# Scene files (.aezl) carry 92 bytes of scene common data; the document's table is 90, the rest reserved.
for off in (90, 91): leaves['Scene Common'].append({'off': off, 'rows': 1, 'bits': 0, 'name': '', 'raw': None, 'disp': []})
# ...and 45 bytes of MIDI control data per mode; the document's 46th byte is reserved.
leaves['MIDI Control'] = [e for e in leaves['MIDI Control'] if e['off'] < 45]
# Assign functions: 1-95 are CC numbers, then the functions the document lists after CC 95.
ASSIGN_FUNCS = None
for t in ('Assign2', 'Assign4', 'Assign8'):
    for e in leaves[t]:
        if e['name'].endswith('Function'):
            opts = [x.strip() for x in ' '.join(e['disp']).split(',') if x.strip()]
            funcs = opts[opts.index('CC 95') + 1:]
            ASSIGN_FUNCS = funcs
            e['raw'] = (0, 95 + len(funcs))
amap = build_map.build(doc)

# ---------------- labels, ranges and formats for every documented setting ----------------
UNITS = {'dB': ' dB', 'cent': ' cent', 'semitone': ' semi', 'EQGAIN': ' dB', 'EQFREQ': ' Hz', 'msec': ' ms', 'sec': ' s', 'Hz': ' Hz'}

def options_of(e):
    t = ' '.join(e['disp'])
    t = re.sub(r'\(Only for AE-30\)', '', t)
    if ',' not in t: return None
    unit = re.search(r'\[(\w+)\]\s*$', t)
    t = re.sub(r'\[(\w+)\]\s*$', '', t)
    opts = [x.strip() for x in t.split(',')]
    if unit and unit.group(1) in UNITS: opts = [o + UNITS[unit.group(1)] if re.fullmatch(r'[-+]?[\d.]+', o) else o for o in opts]
    lo, hi = e['raw'] or (0, 0)
    return opts if len(opts) == hi - lo + 1 and all(opts) else None

def label_of(name, block=''):
    """Short labels: the block already says Part / Tone / EQ / envelope, so the prefix is dropped."""
    n = re.sub(r'\s*\((CC|RPN)#\s*\d+(/\d+)?\)|\s*\(PC\)', '', name).strip()
    n = re.sub(r'^Assign \d+ ', '', n)
    short = re.sub(r'^(Part|Tone|Scene|EQ|TVF Env|TVA Env|Pitch Env|TVF|TVA) (?=\S)', '', n)
    if short not in ('Mode', 'Switch', 'Type'): n = short
    n = re.sub(r' Offset$', '', n).replace(' Send Level', ' Send').replace('Frequency', 'Freq').replace('Tuen', 'Tune')
    n = re.sub(r'^Rx Side Key \((\w+)\)$', r'Rx \1', n).replace(' Controller (', ' (')
    n = re.sub(r'(\w)\((\d)\)$', r'\1 \2', n)
    return n[:1].upper() + n[1:]

def catalog_entry(e, m):
    """e: parsed leaf; m: built map entry (n, a, s, mn, mx, o)"""
    name = e['name']
    if not name or re.match(r'\(?reserved\)?$', name, re.I) or name.lower() == 'reserved': return None
    if any('ASCII' in d for d in e['disp']) or 'AE-30' in name or any('Only for AE-30' in d for d in e['disp']): return None
    if name in ('Fingering Status',) or re.match(r'^NAME \d+$|^Name$', name): return None
    if re.match(r'^(MFX|Chorus|Delay|Reverb) Parameter \d+$', name): return None
    c = {'label': label_of(name, ''), 'vofs': m.get('o', 0)}
    lo, hi = e['raw'] or (0, 0)
    opts = options_of(e)
    if opts and len(opts) > 24:                      # long numeric lists read better as a slider
        if opts[0].startswith('L') and 'Center' in opts:
            c.update(kind='Slider', min=-64, max=63, vofs=lo + 64, format="value === 0 ? 'Center' : value < 0 ? 'L' + (-value) : 'R' + value")
            return c
        isnum = [bool(re.fullmatch(r'-?\d+', o)) for o in opts]
        if sum(isnum) >= len(opts) - 2 and all(isnum[isnum.index(True):len(isnum) - isnum[::-1].index(True)]):
            k = isnum.index(True); last = len(opts) - isnum[::-1].index(True) - 1
            head, tail, first = opts[:k], opts[last + 1:], int(opts[k])
            c.update(kind='Slider', min=0, max=len(opts) - 1, vofs=lo)
            f = f"value - {k} + {first}" if k or first else "value"
            if tail: f = f"value > {last} ? {json.dumps(tail)}[value - {last + 1}] : " + f
            if head: f = f"value < {k} ? {json.dumps(head)}[value] : " + f
            c['format'] = f
            return c
    if opts:
        c.update(kind='Switch' if [o.lower() for o in opts] == ['off', 'on'] else 'SelectBox', options=opts, vofs=lo, min=0, max=len(opts) - 1)
        return c
    mn, mx = m.get('mn', 0), m['mx']
    c.update(kind='Slider', min=mn, max=mx)
    if e['disp']:
        d = e['disp'][0]
        unit = (re.search(r'\[(\w+)\]', d) or [None, None])[1]
        r = build_map.disp_range(d)
        if r:
            a, b, places = r
            k = 10 ** places
            A, B = round(a * k), round(b * k)
            if B - A == mx - mn:
                shift = A - mn
                expr = 'value' if not shift else f'(value + {shift})'
                if places: expr = f'({expr} / {k}).toFixed({places})'
                sign = '+' in d or a < 0
                fmt = (f"((value + {shift}) > 0 ? '+' : '') + " if shift else "(value > 0 ? '+' : '') + ") + expr if sign else expr
                if unit in UNITS: fmt += f" + '{UNITS[unit]}'"
                c['format'] = fmt
    return c

catalog = {}
for r in amap['roots']:
    rk = re.sub(r'_\(\d\)$', '', r['n'])
    top = amap['tables'][r['c']]
    if top and top[0].get('c') is None:              # a leaf table directly under the root (stp)
        blocks = [(None, r['c'], 'Setup')]
    else:
        blocks = [(m['n'], m['c'], None) for m in top]
    for bname, tid, _ in blocks:
        # find the document table this map table came from
        src = next(t for t, es in leaves.items() if len(es) == len(amap['tables'][tid]) and all(e['off'] == x['a'] for e, x in zip(es, amap['tables'][tid])))
        bkey = re.sub(r'_\d+$', '_N', bname) if bname else None
        if bkey and re.search(r'_(motion|pad)_N$|_midi_ctrl_N$', bkey): continue   # AE-30 only; MIDI control layout differs between documents
        for e, m in zip(leaves[src], amap['tables'][tid]):
            c = catalog_entry(e, m)
            if not c: continue
            key = f'{rk}%{bkey}%{e["off"]}' if bkey else f'{rk}%{e["off"]}'
            if bkey == 'Perf_part_N' and e['off'] in (2, 3, 4): continue          # chosen with the tone picker
            catalog[key] = c

# ---------------- effects ----------------
gpdf = pdfplumber.open(guide_pdf)
def pages_with(title):
    return [i + 1 for i, p in enumerate(gpdf.pages) if title in (p.extract_text() or '')[:200]]
mfx_pages = pages_with('MFX/IFX Parameters')
mfx = fx_build.build(fx_tables.group(fx_tables.items(gpdf, mfx_pages[0], mfx_pages[-1])), 'MFX')
send_pages = [p for p in range(1, len(gpdf.pages) + 1) if re.search(r'SCENE/(CHORUS|DELAY|REVERB)', (gpdf.pages[p - 1].extract_text() or '')[:300])]
first, last = send_pages[0], send_pages[-1] + 2
sends = fx_build.sends(gpdf, fx_tables.group(fx_tables.items(gpdf, first, last)), first, last)

# The instrument numbers chorus and delay types in one shared range (delays follow the three choruses,
# JUNO-106 Chorus comes after the delays); reverb types are numbered as listed.
TYPE_ID = {'CHO': {1: 1, 2: 2, 3: 3, 4: 9}, 'DLY': {1: 4, 2: 5, 3: 6, 4: 7, 5: 8}, 'REV': {n: n for n in range(1, 8)}}
BASE = {'MFX': 0x10, 'CHO': 4, 'DLY': 4, 'REV': 3}
BLOCKS = {'MFX': ['Temporary_Scene%Perf_mfx_N', 'Temporary_Scene%Perf_ifx', 'Temporary_Tone_PCM%PCMEX_mfx'],
          'CHO': ['Temporary_Scene%Perf_cho'], 'DLY': ['Temporary_Scene%Perf_dly'], 'REV': ['Temporary_Scene%Perf_rev']}

def default_of(p):
    """A sensible starting value for a freshly chosen effect (used if the instrument doesn't set its own)."""
    l = p['label'].lower()
    if 'options' in p:
        o = p['options']
        if '(sync sw)' in l: return 0
        if o == fx_build.NOTE: return o.index('1/4')
        if 'BYPASS' in o: return o.index('BYPASS')
        if [x.upper() for x in o] == ['OFF', 'ON']: return 1 if 'switch' in l else 0
        if all(re.match(r'^[\d.]+ (Hz|ms)$', x) for x in o): return len(o) // 2
        return 0
    mn, mx, f = p['min'], p['max'], p.get('format', '')
    if 'D100' in f or l == 'balance': return 50
    if "'L'" in f: return 64
    if l in ('level', 'output level') or l.endswith(' level') and mx == 127: return 127 if l == 'level' else 100
    if f.startswith('((value - '):
        shift = int(re.match(r"\(\(value - (\d+)\)", f).group(1))
        return min(mx, shift + (10 if 'feedback' in l else 0))
    if 'feedback' in l: return min(mx, 20)
    if ' hz' in f.lower() and '* 0.05' in f: return 10
    if "' ms'" in f and mx > 100: return min(mx, 300)
    return (mn + mx) // 2

fx_lists, fx_cat = {}, {}
for lst, types in (('MFX', mfx), ('CHO', sends['CHO']), ('DLY', sends['DLY']), ('REV', sends['REV'])):
    items = [{'id': 0, 'text': '00 Thru' if lst == 'MFX' else 'OFF', 'defVal': []}]
    for t in types:
        if lst == 'MFX' and t['num'] == 0: continue
        tid = t['num'] if lst == 'MFX' else TYPE_ID[lst][t['num']]
        num = f"{t['num']:02d}" if lst == 'MFX' else str(t['num'])
        name = t['name'] if lst != 'MFX' else t['long']
        items.append({'id': tid, 'text': f'{num} {name}', 'defVal': [default_of(p) for p in t['params']]})
        for i, p in enumerate(t['params']):
            c = {'label': p['label'], 'vofs': 32768}
            if 'options' in p: c.update(kind='SelectBox' if len(p['options']) > 2 or [x.upper() for x in p['options']] != ['OFF', 'ON'] else 'Switch', options=p['options'], min=0, max=len(p['options']) - 1)
            else: c.update(kind='Slider', min=p['min'], max=p['max'], format=p['format'])
            for b in BLOCKS[lst]: fx_cat[f'{b}%{BASE[lst] + 4 * i}%fx{num}'] = c
    fx_lists[lst] = items
catalog.update(fx_cat)

# ---------------- names from the Parameter Guide ----------------
cc_page = next(i + 1 for i, p in enumerate(gpdf.pages) if (p.extract_text() or '').lstrip().startswith('Control Change List'))
cc_text = subprocess.check_output(['pdftotext', '-layout', '-f', str(cc_page), '-l', str(cc_page), guide_pdf, '-']).decode('utf-8', 'replace')
cc = {}
for m in re.finditer(r'^[ \t]*(\d{1,3})[ \t]{2,}(\S.*?)(?:[ \t]{2,}\S.*)?$', cc_text, re.M):
    n, what = int(m.group(1)), m.group(2).strip()
    what = re.sub(r'\s*\(depend on scene\)|^AE-30\s+', '', what).strip()
    if 1 <= n <= 95 and what and not what.startswith('('): cc[n] = what.replace('Mudulation', 'Modulation')
cc_names = [f'CC{n:02d}' + (f':{cc[n].upper()}' if cc.get(n) else '') for n in range(1, 96)]

def opts_for(table, name):
    for e in leaves[table]:
        if e['name'] == name: return [x.strip() for x in ' '.join(e['disp']).split(',') if x.strip()]
osc_types = opts_for('Tone Synth Partial', 'OSC Type')
va_waves = opts_for('Tone Synth Partial', 'VA Waveform')

# ---------------- Scene List: preset categories, tones ----------------
st = text(list_pdf)
cats = {}
for m in re.finditer(r'(?<![\d:])(\d\d): ([A-Z][A-Za-z/&\' .-]*[a-z])', st[:st.index('Tone List')] if 'Tone List' in st else st):
    i = int(m.group(1))
    if 1 <= i <= 12 and i not in cats and 'Kit' not in m.group(2): cats[i] = m.group(2).strip()
presets = [{'cat': cats.get(i, f'Bank {i}'), 'scenes': []} for i in range(1, 13)]
banks = {'A': (71, 72), 'B': (71, 73), 'C': (71, 74), 'SN': (89, 66), 'DK': (70, 66)}
tl = st[st.index('Tone List'):] if 'Tone List' in st else st
pat = re.compile(r'(\d{3})\s{2,}(\S.*?)\s{2,}(?:(\d+:\S.*?)|(Drum Kit))\s{2,}(\d+)\s+(\d+)\s+(\d+)(?=\s|$)')
found = {}
for l in tl.splitlines():
    for m in pat.finditer(l):
        name, cat = m.group(2).strip(), (re.sub(r'^\d+:', '', m.group(3).strip()) if m.group(3) else 'Drum Kit')
        found[(int(m.group(5)), int(m.group(6)), int(m.group(7)))] = (name, cat)
tones, tone_cats = {}, {}
for b, (msb, lsb) in banks.items():
    n = max([pc for (m_, l_, pc) in found if (m_, l_) == (msb, lsb)] or [0])
    names, cs = [''] * n, [''] * n
    for (m_, l_, pc), (name, cat) in found.items():
        if (m_, l_) == (msb, lsb):
            names[pc - 1] = '' if name == 'No Assign' else name
            cs[pc - 1] = '' if cat == 'No Assign' else cat
    tones[b], tone_cats[b] = names, cs

# Wave List: the PCM waves in banks A-D, by number (1 = first). Stored in a partial as wave group
# type INT with these group numbers (the numbers aren't in the document; the instrument uses them).
WAVE_GROUP = {'A': 8, 'B': 10, 'C': 11, 'D': 36}
waves, cur = {}, None
for l in st.splitlines():
    m = re.match(r'\s*Wave Bank ([A-D])\b', l)
    if m: cur = m.group(1); waves.setdefault(cur, {}); continue
    if cur and re.match(r'\s*(Tone List|Scene List|Drum Kit)', l): cur = None
    if cur:
        for n, name in re.findall(r'(\d{1,4})\s{2,}(\S.*?)(?=\s{2,}\d{1,4}\s{2,}|\s*$)', l):
            waves[cur][int(n)] = name.strip()
wave_lists = {b: [v.get(i, '') for i in range(1, max(v) + 1)] for b, v in sorted(waves.items()) if v}

sizes = build_map.SIZES
data = {'source': 'Built from Roland\'s public AE-30/AE-20 MIDI Implementation, Parameter Guide and Scene List',
        'toneCats': tone_cats, 'map': amap, 'sizes': sizes, 'fx': fx_lists, 'presets': presets, 'catalog': catalog,
        'tones': tones, 'vaWaves': va_waves, 'oscTypes': osc_types, 'ccNames': cc_names, 'assignFuncs': ASSIGN_FUNCS, 'waves': wave_lists, 'waveGroups': WAVE_GROUP}
open(out, 'w').write('window.AE_DATA = ' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';\n')
print('wrote', out, len(catalog), 'settings,', sum(len(t) - 1 for t in fx_lists.values()), 'effect types,',
      sum(1 for v in tones.values() for x in v if x), 'tones,', sum(len(v) for v in wave_lists.values()), 'waves')
