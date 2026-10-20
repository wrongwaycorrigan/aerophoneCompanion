"""Parse the Parameter Address Map from Roland's public AE-30/AE-20 MIDI Implementation
(pdftotext -layout output) into plain tables:
  maps:   {table: [(offset7, desc, subtable)]}   (nested address maps, ':' rows expanded)
  leaves: {table: [{off, rows, bits, name, raw:(lo,hi)|None, disp:[text lines]}]}
"""
import re, sys, json

def lin(h):            # 7-bit address bytes -> linear address
    v = 0
    for b in h: v = v * 128 + b
    return v

def parse(path):
    txt = open(path, encoding='utf-8', errors='replace').read().splitlines()
    start = next(i for i, l in enumerate(txt) if l.startswith('3. Parameter Address Map'))
    end = next(i for i, l in enumerate(txt) if l.startswith('4. Supplementary Material'))
    tables, cur = {}, '_top'
    tables[cur] = []
    for l in txt[start:end]:
        m = re.match(r'^\* \[(.+?)\]', l)
        if m: cur = m.group(1); tables[cur] = []; continue
        if l.strip().startswith('|'): tables[cur].append(l.strip())
    maps, leaves = {}, {}
    for name, rows in tables.items():
        cells = [[c.strip() for c in r.strip('|').split('|')] for r in rows]
        if any(len(c) == 3 and re.match(r'^#?\s*[0-9A-F]{2} [0-9A-F]{2}$', c[0]) for c in cells):
            leaves[name] = leaf_rows(cells)
        else:
            maps[name] = map_rows(cells)
    return maps, leaves

def map_rows(cells):
    out, prev = [], None
    for c in cells:
        if len(c) < 2: continue
        m = re.match(r'^([0-9A-F]{2}(?: [0-9A-F]{2})+)$', c[0])
        if m:
            d = c[1]; t = re.search(r'\[(.+?)\]\s*$', d)
            if not t: continue
            off = [int(x, 16) for x in c[0].split()]
            desc = re.sub(r'\s+', ' ', d[:t.start()]).strip()
            row = (lin(off), desc, t.group(1))
            if prev == ':' and out:          # expand "a, b, :, z" runs
                a, b = out[-2], out[-1]; step = b[0] - a[0]
                na = re.search(r'\((\d+)\)', b[1]); nz = re.search(r'\((\d+)\)', desc)
                if na and nz:
                    w = len(na.group(1))
                    for k in range(int(na.group(1)) + 1, int(nz.group(1))):
                        out.append((b[0] + step * (k - int(na.group(1))), re.sub(r'\(\d+\)', '(%0*d)' % (w, k), b[1]), b[2]))
                else:
                    na = re.search(r'(\d+)$', b[1]); nz = re.search(r'(\d+)$', desc)
                    for k in range(int(na.group(1)) + 1, int(nz.group(1))):
                        out.append((b[0] + step * (k - int(na.group(1))), re.sub(r'\d+$', str(k), b[1]), b[2]))
            out.append(row); prev = None
        elif c[0] == ':':
            prev = ':'
    return out

def leaf_rows(cells):
    out, group = [], None
    for c in cells:
        if len(c) != 3: continue
        o, bits, d = c
        m = re.match(r'^(#)?\s*([0-9A-F]{2}) ([0-9A-F]{2})$', o)
        if m:
            off = lin([int(m.group(2), 16), int(m.group(3), 16)])
            nb = bits.replace(' ', '').lstrip('0'); nb = len(nb)
            if m.group(1) or group is None or not group['open']:
                e = {'off': off, 'rows': 1, 'bits': nb, 'name': '', 'raw': None, 'disp': [], 'open': bool(m.group(1))}
                out.append(e); group = e
            else:
                group['rows'] += 1
            if d:
                mm = re.match(r'^(.*?)\s*\(\s*(-?\d+)\s*-\s*(-?\d+)\s*\)\s*$', d)
                if mm: group['name'] = mm.group(1).strip(); group['raw'] = (int(mm.group(2)), int(mm.group(3)))
                else: group['name'] = d
                group['open'] = False
        elif not o and not bits and group is not None:
            if d: group['disp'].append(d)
    for e in out: e.pop('open', None)
    return out

if __name__ == '__main__':
    maps, leaves = parse(sys.argv[1])
    json.dump({'maps': maps, 'leaves': leaves}, open(sys.argv[2], 'w'), indent=0)
    for k, v in maps.items(): print('MAP', k, len(v))
    for k, v in leaves.items(): print('LEAF', k, len(v), 'size', v[-1]['off'] + v[-1]['rows'] if v else 0)
