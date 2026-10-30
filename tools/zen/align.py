"""Work out where each AE-20 tone setting sits in a ZENOLOGY tone record, by aligning the
same tone read from the instrument (Aerophone Companion's .tone.json) with its ZENOLOGY export.
Settings appear in the same order in both; ZENOLOGY packs them as little-endian 1/2/4-byte values,
centred settings stored signed. A local alignment (settings in order, small gaps allowed) finds them."""
import json, sys, zlib

def load_data():
    t = open('/home/claude/next/app/data.js').read()
    return json.loads(t[t.index('{'):t.rindex('}') + 1])
D = load_data(); S = D['sizes']; M = D['map']
root = [r for r in M['roots'] if r['n'] == 'Temporary_Tone_PCM_(1)'][0]
TABLES = {e['n'].replace('PCMEX_', ''): M['tables'][e['c']] for e in M['tables'][root['c']]}

def nbytes(s):
    if s >= S['PADDING']: return s - S['PADDING']
    return {S['INTEGER2x4']: 2, S['INTEGER2x7']: 2, S['INTEGER4x4']: 4, S['INTEGER8x4']: 8}.get(s, 1)
def dec(b, off, s):
    n = nbytes(s)
    if s in (S['INTEGER2x4'], S['INTEGER4x4'], S['INTEGER8x4']):
        v = 0
        for i in range(n): v = (v << 4) | (b[off + i] & 15)
        return v
    if s == S['INTEGER2x7']: return (b[off] << 7) | b[off + 1]
    return b[off]

def zen_records(path):
    d = open(path, 'rb').read(); assert d[:4] == b'SVZa'
    raw = zlib.decompress(d[0x60:]); n = int.from_bytes(raw[12:16], 'little'); size = int.from_bytes(raw[8:12], 'little')
    return [raw[0x20 + i * size:0x20 + (i + 1) * size] for i in range(n)]

def entries(block):
    """[(name, ae_offset, ae_size, centre_offset, max)] for a block, reserved included"""
    return [(e['n'], e['a'], e['s'], e.get('o', 0), e['mx']) for e in TABLES[block] if e.get('c') is None]

def widths(e):
    nm, a, s, o, mx = e
    if nbytes(s) == 4 and o == 32768: return (2,)          # effect parameters: 2 bytes, signed
    span = mx - min(0, -o)
    return (1,) if mx <= 255 and o <= 255 else (2, 4)

def zval(rec, pos, w, signed):
    v = int.from_bytes(rec[pos:pos + w], 'little', signed=signed)
    return v

def align(block, ae_blocks, rec, stride, n_inst, window, gap_max=6):
    """ae_blocks: list of raw byte lists (one per instance). Returns [(entry, pos, width, signed, score)]"""
    E = entries(block)
    vals = [[dec(b, e[1], e[2]) for b in ae_blocks] for e in E]
    lo, hi = window
    NEG = -1e9
    # score[e][pos][w-option]
    def score(i, pos, w):
        nm, a, s, o, mx = E[i]
        best = 0
        for signed, tv in ((False, vals[i]), (True, [v - o for v in vals[i]])):
            if not signed and o: continue
            if signed and not o: continue
            sc = 0
            for k in range(n_inst):
                p = pos + stride * k
                if p + w > len(rec): return 0
                if zval(rec, p, w, signed if (signed or w > 1) else False) == tv[k] or (w == 1 and not signed and rec[p] == tv[k] & 255): sc += 1
            # distinctive values count more: non-zero, and different across instances
            weight = 1 + (len(set(tv)) > 1) * 2 + (any(tv) and 1)
            best = max(best, sc * weight if sc == n_inst else 0)
        return best
    reserved = lambda i: E[i][0] in ('(reserved)', 'Reserved', '')
    dp = [dict() for _ in E]            # dp[i][end] = (score, start, width, prev_end)
    for st in range(lo, hi):
        for w in widths(E[0]) + ((0,) if reserved(0) else ()):
            sc = score(0, st, w) if w else 0
            e = st + w
            if e not in dp[0] or sc > dp[0][e][0]: dp[0][e] = (sc, st, w, None)
    for i in range(1, len(E)):
        opts = widths(E[i]) + ((0,) if reserved(i) else ())
        for pe, (psc, *_r) in dp[i - 1].items():
            for g in range(gap_max + 1):
                st = pe + g
                if st >= hi + 400: continue
                for w in opts:
                    sc = psc + (score(i, st, w) if w else 0) - 0.3 * g
                    e = st + w
                    if e not in dp[i] or sc > dp[i][e][0]: dp[i][e] = (sc, st, w, pe)
    end = max(dp[-1], key=lambda k: dp[-1][k][0]); total = dp[-1][end][0]; out = []
    for i in range(len(E) - 1, -1, -1):
        sc, st, w, pe = dp[i][end]
        out.append((E[i], st, w)); end = pe
    return list(reversed(out)), total
