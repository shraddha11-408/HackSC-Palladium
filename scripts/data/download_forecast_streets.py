"""Download a bounded full-zone OSM street overlay, not a validated routing graph."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path('data/activity'))
    args = parser.parse_args()
    boundary = json.loads(Path('docs/upc-lyft-boundary.geojson').read_text())
    points = boundary['geometry']['coordinates'][0]
    west, south = min(p[0] for p in points), min(p[1] for p in points)
    east, north = max(p[0] for p in points), max(p[1] for p in points)
    query = f'[out:json][timeout:90];way["highway"]({south-.001},{west-.001},{north+.001},{east+.001});out geom;'
    response = None
    for endpoint in ('https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'):
        try:
            response = httpx.get(endpoint, params={'data': query}, timeout=110,
                headers={'User-Agent': 'Palladium-Activity-Research/0.1'})
            response.raise_for_status()
            break
        except httpx.HTTPError:
            if 'kumi' in endpoint:
                raise
    assert response is not None
    if len(response.content) > 30*1024**2:
        raise ValueError('Unexpectedly large street extract')
    payload = response.json()
    if not payload.get('elements') or payload.get('remark'):
        raise ValueError('Overpass returned an incomplete extract')
    args.out.mkdir(parents=True, exist_ok=True)
    raw = response.content
    (args.out/'forecast-streets.json').write_bytes(raw)
    (args.out/'forecast-streets-provenance.json').write_text(json.dumps({
        'downloaded_at': datetime.now(timezone.utc).isoformat(), 'sha256': hashlib.sha256(raw).hexdigest(),
        'source': 'https://www.openstreetmap.org/copyright', 'license': 'ODbL', 'query': query,
        'boundary': boundary['properties']['name'], 'purpose': 'Full-zone street visualization; access/connectivity not validated for routing',
    }, indent=2))
    print('Saved', len(payload['elements']), 'OSM ways for the full zone')


if __name__ == '__main__':
    main()
