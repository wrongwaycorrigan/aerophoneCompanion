"""Write a ZENOLOGY user bank (SVZ) holding one AE-20 tone, from an Aerophone Companion .tone.json.
usage: build_bank.py <spec.json> <template bank> <tone.json> <out.bin>"""
import json, sys, zlib, struct
sys.path.insert(0, __file__.rsplit('/', 1)[0]); import align as A

def record(spec, init, blocks, name):
    r = bytearray(init)
    for blk, sp in spec.items():
        for k in range(sp['copies']):
            key = f'{blk}_{k + 1}' if sp['copies'] > 1 else blk
            if key not in blocks: continue
            src = [int(x, 16) for x in blocks[key].split()]
            for f in sp['fields']:
                v = A.dec(src, f['ae'], f['size']) - f['centre']
                p = sp['base'] + sp['stride'] * k + f['pos']
                r[p:p + f['w']] = int(v).to_bytes(f['w'], 'little', signed=f['signed'] or v < 0)
    nm = name[:16].ljust(16).encode('ascii', 'replace'); r[0x10:0x20] = nm
    return bytes(r)

def bank(template_file, rec, slot=0):
    d = open(template_file, 'rb').read(); raw = bytearray(zlib.decompress(d[0x60:]))
    size = int.from_bytes(raw[8:12], 'little'); raw[0x20 + slot * size:0x20 + (slot + 1) * size] = rec
    z = zlib.compress(bytes(raw), 9)
    head = bytearray(d[:0x60])
    struct.pack_into('<I', head, 0x1c, 0x40 + len(z))            # sizes after the 32-byte file header
    struct.pack_into('<I', head, 0x38, 0x20 + len(z))
    struct.pack_into('<I', head, 0x3c, zlib.crc32(z))
    struct.pack_into('<I', head, 0x48, len(raw))
    return bytes(head) + z

if __name__ == '__main__':
    spec = json.load(open(sys.argv[1])); init = A.zen_records(sys.argv[2])[0]
    tone = json.load(open(sys.argv[3]))
    rec = record(spec, init, tone['blocks'], tone['tone'])
    open(sys.argv[4], 'wb').write(bank(sys.argv[2], rec))
    print('wrote', sys.argv[4])
