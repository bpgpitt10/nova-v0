from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel_path: str, old: str, new: str) -> None:
    path = ROOT / rel_path
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{rel_path}: expected exactly one match, found {count}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


for rel_path, url_const in [
    ('src/adapters/gsproWindObservation.ts', "const HELPER_WIND_URL = 'http://127.0.0.1:8787/wind'"),
    ('src/adapters/gsproLieObservation.ts', "const HELPER_LIE_URL = 'http://127.0.0.1:8787/lie'"),
]:
    replace_once(
        rel_path,
        url_const,
        url_const + "\n\ntype LoopbackRequestInit = RequestInit & { targetAddressSpace?: 'loopback' }\nconst LOOPBACK_FETCH_INIT: LoopbackRequestInit = {\n  cache: 'no-store',\n  targetAddressSpace: 'loopback',\n}",
    )
    replace_once(
        rel_path,
        "fetch(" + ("HELPER_WIND_URL" if 'Wind' in rel_path else "HELPER_LIE_URL") + ", { cache: 'no-store' })",
        "fetch(" + ("HELPER_WIND_URL" if 'Wind' in rel_path else "HELPER_LIE_URL") + ", LOOPBACK_FETCH_INIT)",
    )

print('Loopback fetch intent added to wind + lie OCR adapters.')
