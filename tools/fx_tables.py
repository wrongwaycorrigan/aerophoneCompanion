"""Extract effect parameter tables (Parameter / Value / Explanation) from Roland's public
AE-30/AE-20 Parameter Guide, grouped under their numbered headings ("01  Equalizer")."""
import re, sys, json
import pdfplumber

HEAD = re.compile(r'^(\d{1,2})\s{1,}(\S.*)$')

def items(pdf, first, last):
    out = []
    for pn in range(first, last + 1):
        page = pdf.pages[pn - 1]
        mid = page.width / 2
        for col, half in enumerate((page.crop((0, 0, mid, page.height)), page.crop((mid, 0, page.width, page.height)))):
            for l in half.extract_text_lines(layout=False, strip=True):
                m = HEAD.match(l['text'])
                if m and l['chars'][0]['size'] > 10:
                    out.append((pn, col, l['top'], 'head', (m.group(1), m.group(2).strip())))
            for t in half.find_tables():
                rows = t.extract()
                if rows and rows[0] and (rows[0][0] or '').strip() == 'Parameter':
                    out.append((pn, col, t.bbox[1], 'table', rows[1:]))
    out.sort(key=lambda x: (x[0], x[1], x[2]))
    return out

def group(its):
    fx, cur = [], None
    for pn, col, top, kind, data in its:
        if kind == 'head':
            cur = {'num': data[0], 'name': data[1], 'page': pn, 'params': []}; fx.append(cur)
        elif kind == 'table' and cur is not None:
            for r in data:
                name = (r[0] or '').replace('\n', ' ').strip()
                value = (r[1] or '').strip() if len(r) > 1 else ''
                if not name and cur['params']:         # continuation row of the previous parameter
                    cur['params'][-1]['value'] += ' ' + value; continue
                cur['params'].append({'name': name, 'value': value})
    return fx

if __name__ == '__main__':
    pdf = pdfplumber.open(sys.argv[1])
    first, last = int(sys.argv[2]), int(sys.argv[3])
    fx = group(items(pdf, first, last))
    json.dump(fx, open(sys.argv[4], 'w'), indent=1)
    for f in fx: print(f['num'], f['name'], len(f['params']), '|', ' / '.join(p['name'] for p in f['params'])[:150])
