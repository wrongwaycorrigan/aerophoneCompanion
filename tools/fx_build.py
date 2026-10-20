"""Turn the effect tables from the Parameter Guide into the app's effect definitions:
type lists and, per type, each parameter's label, stored range, display format and choices.
How values are stored (the step and whether negative values are offset) follows the
conventions of Roland's effect engine; NOTES below records the few places the guide is silent."""
import re, json, sys

NOTE = '1/64T, 1/64, 1/32T, 1/32, 1/16T, 1/32., 1/16, 1/8T, 1/16., 1/8, 1/4T, 1/8., 1/4, 1/2T, 1/4., 1/2, 1T, 1/2., 1, 2T, 1., 2'.split(', ')
JOIN_NEXT = {'CLEAN', 'MATCH', 'BG', 'SLDN', 'METAL', 'MS', 'OD-2', 'SMALL', 'BUILT-IN'}

def clean(v):
    v = v.replace('–', '–').replace('−', '-').replace('Ó', '->')
    return re.sub(r'\s+', ' ', v).strip()

def tokens(text):
    """'SMALL 1 SMALL 2 MIDDLE BG STACK 1' -> ['SMALL 1', 'SMALL 2', 'MIDDLE', 'BG STACK 1']"""
    out, words = [], text.split()
    i = 0
    while i < len(words):
        w = words[i]
        while i + 1 < len(words) and (w.split()[-1] in JOIN_NEXT or re.fullmatch(r'\d', words[i + 1]) or words[i + 1] in ('TURBO', 'LEAD', 'TWIN', 'DRIVE', 'STACK', '5150') and w not in ('FUZZ',)):
            if w == 'MS1959I+II': break
            i += 1; w += ' ' + words[i]
            if re.fullmatch(r'\d', words[i]) or w.endswith(('TURBO', 'LEAD', 'TWIN', 'DRIVE', '5150')): break
        out.append(w); i += 1
    return out

def expand(items):
    """'ROOM1–3' -> ROOM1, ROOM2, ROOM3"""
    out = []
    for it in items:
        m = re.fullmatch(r'([A-Z]+)(\d)–(\d)', it)
        if m: out += [m.group(1) + str(k) for k in range(int(m.group(2)), int(m.group(3)) + 1)]
        else: out.append(it)
    return out

def num_places(s): return len(s.split('.')[1]) if '.' in s else 0

# Roland's pre-delay scale: 0.0-4.9 ms in 0.1, 5-9.5 in 0.5, 10-49 in 1, 50-100 in 2 (126 steps)
PREDELAY = [f'{x / 10:.1f}' for x in range(50)] + [f'{5 + x / 2:.1f}' for x in range(10)] + [str(10 + x) for x in range(40)] + [str(50 + 2 * x) for x in range(26)]
# Where the guide gives only the end points of a range, the step it is stored in
STEP = {('Exciter', 'Split1 Frequency'): 10, ('Exciter', 'Split2 Frequency'): 10}
# Choices stored from 1 rather than 0
BASE1 = {('Warm Hall', 'Pre LPF'), ('Warm Hall', 'PreLoop LPF')}
# The reverb tables refer to notes (*3)-(*8), printed under them as (*1)-(*6)
NOTE_SHIFT = {'REV': 2}
# Pre-delays the guide lists as 0-100 that use the pre-delay scale above
PREDELAY_AT = {('Warm Hall', 'PreDelay'), ('Hall', 'PreDelay')}
# Ranges stored from 0 although shown from 1, and negative ranges stored with an offset
FROM0 = {('Hall', 'Size')}
OFFSET = {('Hall', 'LF Damp Gain'), ('Hall', 'HF Damp Gain')}
# A rate on a curve the guide doesn't describe: shown as its position, 0-111
CURVED = {('SBF-325', 'Rate (Hz)'): 111}

def param(name, value, family, foot, fxname=''):
    v = clean(value)
    if (fxname, name) in CURVED: return {'min': 0, 'max': CURVED[(fxname, name)], 'format': 'value'}
    if v in ('0.0–100 (msec)', '0.0–100.0 (msec)') and 'Pre' in name or (fxname, name) in PREDELAY_AT: return {'options': [x + ' ms' for x in PREDELAY]}
    unit = ''
    m = re.search(r'\((Hz|kHz|dB|msec|sec|deg|%|cent|semi)\)', v)
    if m: unit = m.group(1); v = (v[:m.start()] + v[m.end():]).strip(' ,')
    if v.startswith('Note') or v in ('Note',): return {'options': NOTE}
    m = re.fullmatch(r'\(\*(\d)\)', v)
    if m:
        d = param(name, foot[str(int(m.group(1)) - NOTE_SHIFT.get(family, 0))], family, foot, fxname)
        if (fxname, name) in BASE1 and 'options' in d:
            return {'min': 1, 'max': len(d['options']), 'format': json.dumps(d['options']) + '[value - 1]'}
        return d
    if v.startswith('Type of guitar amp'): return {'options': tokens(v[len('Type of guitar amp'):])}
    if v == 'D100:0W–D0:100W': return {'min': 0, 'max': 100, 'format': "'D' + (100 - value) + ':' + value + 'W'"}
    m = re.fullmatch(r'L64–63R', v)
    if m: return {'min': 0, 'max': 127, 'format': "value === 64 ? 'C' : value < 64 ? 'L' + (64 - value) : (value - 64) + 'R'"}
    m = re.fullmatch(r'([-+]?\d+(?:\.\d+)?)–([-+]?\d+(?:\.\d+)?)', v)
    if m:
        a, b = m.group(1), m.group(2)
        places = max(num_places(a), num_places(b))
        A, B = float(a), float(b)
        step = 10 ** -places
        if places and A > 0 and abs(A / step - round(A / step)) < 1e-9 and A < 1 and num_places(a) == places and round(A / step) > 1 and unit == 'Hz': step = A
        if (fxname, name) in STEP: step = STEP[(fxname, name)]
        if unit == 'deg': step = 2
        if unit == '%' and A == -98: step = 2
        if unit == 'cent' and A == -100 and family == 'MFX': step = 2
        lo, hi = round(A / step), round(B / step)
        shift = 0
        if lo < 0 and places == 0 and (family != 'REV' or (fxname, name) in OFFSET): shift = -lo
        if (fxname, name) in FROM0: shift = -lo
        mn, mx = lo + shift, hi + shift
        sign = a.startswith('+') or b.startswith('+')
        expr = 'value' if not shift else f'(value - {shift})'
        if step != 1: expr = f'({expr} * {step:g})'
        if places: expr = f'{expr}.toFixed({places})'
        u = {'msec': ' ms', 'sec': ' s', 'deg': '°', '%': '%', 'cent': ' cent', 'semi': ' semi', 'dB': ' dB', 'Hz': ' Hz', 'kHz': ' kHz'}.get(unit, '')
        fmt = (f"((value - {shift}) > 0 ? '+' : '') + " if sign and shift else "(value > 0 ? '+' : '') + " if sign else '') + expr + (f" + '{u}'" if u else '')
        return {'min': mn, 'max': mx, 'format': fmt}
    if ',' in v:
        items = [x.strip() for x in v.split(',') if x.strip()]
        items = expand(items)
        if unit and unit not in ('dB',): items = [x + ('' if not re.fullmatch(r'[\d.]+', x) else ' ' + unit) for x in items]
        return {'options': items}
    if v: return {'options': tokens(v)}
    return None

def build(fx, family, foot_by_page=None):
    types = []
    for e in fx:
        ps, prev = [], None
        foot = {}
        if foot_by_page:
            for pg in sorted(foot_by_page):
                if pg >= e['page']:
                    for k, t in foot_by_page[pg].items(): foot.setdefault(k, t)
        for p in e['params']:
            if p['name'] in ('DLY SW', 'REV SW', 'CH SW', 'FX', 'OUTPUT', 'Delay Type', 'Reverb Type', 'RV SW'): break
            name = re.sub(r'\s+', ' ', p['name'])
            d = param(name, p['value'], family, foot, re.sub(r'\s*\([^)]*\)', '', clean(e['name'])).strip()) if p['value'] else (dict(prev) if prev else None)
            if d is None: raise ValueError(f"{e['name']}: no value for {name}")
            prev = d
            ps.append(dict(label=name, **d))
        nm = re.sub(r'\s*\([^)]*\)', '', clean(e['name'])).replace(' -> ', '->').strip() or clean(e['name'])
        paren = re.search(r'\(([^)]*)\)', clean(e['name']))
        long = nm
        if paren and paren.group(1)[:1].lower() == nm[:1].lower() and paren.group(1).upper() != paren.group(1) and not nm.startswith('Gt'):
            long = paren.group(1)
        types.append({'num': int(e['num']), 'name': nm, 'long': long, 'params': ps})
    return types

def footnotes(pdf, first, last):
    """{page: {'1': '...', ...}} from the '(*n) values' notes under the send-effect tables"""
    out = {}
    for pn in range(first, last + 1):
        p = pdf.pages[pn - 1]; mid = p.width / 2
        for half in (p.crop((0, 0, mid, p.height)), p.crop((mid, 0, p.width, p.height))):
            t = half.extract_text() or ''
            for m in re.finditer(r'\(\*(\d)\)\s*([^\n]*(?:\n(?!\(\*)[^\n]*){0,3})', t):
                txt = m.group(2)
                if not (re.match(r'^[A-Z0-9/]', txt) and ',' in txt): continue
                lines = []
                for l in txt.split('\n'):
                    if lines and not re.match(r'^[\d/A-Z][\w/., ()+:]*$', l.strip()): break
                    if not re.search(r',|\(Hz\)|BYPASS$', l) and lines: break
                    lines.append(l.strip())
                out.setdefault(pn, {})[m.group(1)] = ' '.join(lines)
    return out

def sends(pdf, tables, first=33, last=38):
    foot = footnotes(pdf, first, last)
    cho, dly, rev = tables[:4], tables[4:9], tables[9:]
    return {'CHO': build(cho, 'CHO'), 'DLY': build(dly, 'DLY', foot), 'REV': build(rev, 'REV', foot)}
