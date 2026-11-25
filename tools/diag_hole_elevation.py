"""Diagnostic: heights Live Caddie reads for one hole's tee and pin, from every terrain source in a
loaded course's packages (Tobacco Road 14, 24 Nov: a downhill par 3 read as uphill)."""
import base64, json, struct, sys, urllib.request, zlib

BASE = 'https://kdjfdchzfemjpmaqpobn.supabase.co/storage/v1/object/public/course-packages'
slug, hole = sys.argv[1], sys.argv[2]
points = {name: (float(x), float(y)) for name, x, y in (p.split(':') for p in sys.argv[3:])}


def get(name):
    try:
        with urllib.request.urlopen(f'{BASE}/{slug}/{name}', timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f'{name}: not available ({e})')
        return None


def grid_values(g, n):
    raw = base64.b64decode(g['valuesBase64'])
    try:
        raw = zlib.decompress(raw)
    except zlib.error:
        pass
    return struct.unpack(f'<{n}H', raw[: 2 * n])


def sample(g, vals, x, y, spacing_key):
    sp = g[spacing_key]
    gx, gy = (x - g['minX']) / sp, (y - g['minY']) / sp
    c0, r0 = int(gx // 1), int(gy // 1)
    w, h = g['width'], g['height']
    if c0 < 0 or r0 < 0 or c0 >= w - 1 or r0 >= h - 1:
        return None
    nod = g.get('nodata', 65535)
    c = [vals[r0 * w + c0], vals[r0 * w + c0 + 1], vals[(r0 + 1) * w + c0], vals[(r0 + 1) * w + c0 + 1]]
    if any(v == nod for v in c):
        return None
    dc, dr = gx - c0, gy - r0
    raw = c[0] * (1 - dc) * (1 - dr) + c[1] * dc * (1 - dr) + c[2] * (1 - dc) * dr + c[3] * dc * dr
    return round(g['elevationOffsetFt'] + raw / 10, 2)


for name in ('course-v1.json', 'course-v1-lidar.json'):
    pkg = get(name)
    if not pkg:
        continue
    h = pkg['holes'][hole]
    t = h.get('terrain')
    print(f'== {name} hole {hole}: markers {json.dumps(h.get("markers"))[:300]}')
    if not t:
        print('  no terrain')
        continue
    meta = {k: v for k, v in t.items() if k != 'valuesBase64'}
    print('  terrain', json.dumps(meta)[:500])
    vals = grid_values(t, t['width'] * t['height'])
    for pname, (x, y) in points.items():
        print(f'  {pname} ({x}, {y}): {sample(t, vals, x, y, "runtimeSpacingYds")} ft')
    pin = (h.get('markers') or {}).get('pin')
    if pin:
        print(f'  package pin {pin}: {sample(t, vals, pin[0], pin[1], "runtimeSpacingYds")} ft')
gd = get('green-detail-v1.json')
if gd:
    g = gd['holes'][hole]
    print('== green-detail', json.dumps({k: v for k, v in g['grid'].items() if k != 'valuesBase64'}), 'summary', json.dumps(g.get('greenSummary')))
    vals = grid_values(g['grid'], g['grid']['width'] * g['grid']['height'])
    for pname, (x, y) in points.items():
        print(f'  {pname} ({x}, {y}): {sample(g["grid"], vals, x, y, "spacingYds")} ft')

# Grid around the green (25 Nov: why the 7i/8i/9i got only ~4 yd of drop).
lidar = get('course-v1-lidar.json')
t = lidar['holes'][hole]['terrain'] if lidar else None
tv = grid_values(t, t['width'] * t['height']) if t else None
gg = gd['holes'][hole]['grid'] if gd else None
gv = grid_values(gg, gg['width'] * gg['height']) if gg else None
print('== grid: terrain ft (green-detail ft in brackets); rows y, cols x')
xs = list(range(-30, 31, 5))
print('y\\x ' + ' '.join(f'{x:>12}' for x in xs))
for y in range(205, 129, -5):
    cells = []
    for x in xs:
        a = sample(t, tv, x, y, 'runtimeSpacingYds') if t else None
        b = sample(gg, gv, x, y, 'spacingYds') if gg else None
        cells.append(f'{a if a is not None else "-":>6}[{b if b is not None else "-":>5}]'[:12].rjust(12))
    print(f'{y:>4} ' + ' '.join(cells))
