"""Acquire the pinned free generator and build the bounded South Mumbai district."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/mumbai'


def configuration():
    value = json.loads((ROOT / 'config/mumbai-map.json').read_text())
    bounds = value.get('bbox', [])
    if value.get('schema') != 'agentcity.mumbai-map.v1' or value.get('world') != 'agentcity_mumbai':
        raise ValueError('Unknown Mumbai generation profile')
    if len(bounds) != 4 or any(not isinstance(n, (float, int)) or not math.isfinite(n) for n in bounds):
        raise ValueError('Finite geographic bounds required')
    south, west, north, east = bounds
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        raise ValueError('Ordered geographic bounds required')
    area = (north - south) * (east - west) * 111.32 ** 2 * math.cos(math.radians(south))
    if not 0 < area <= 10:
        raise ValueError('Laptop map must be at most ten square kilometres')
    spawn = value['spawn']
    if not (south <= spawn['latitude'] <= north and west <= spawn['longitude'] <= east):
        raise ValueError('Spawn must be inside the selected district')
    return value


def acquire(config):
    if sys.platform != 'darwin':
        raise RuntimeError('This pinned generator profile is for macOS')
    source = config['generator']
    expected_url = 'https://github.com/louis-e/arnis/releases/download/v3.4.0/arnis-mac-universal.tar.gz'
    if source['url'] != expected_url or source['binary'] != 'arnis-mac-universal':
        raise ValueError('Official pinned Arnis release required')
    BASE.mkdir(parents=True, exist_ok=True)
    archive = BASE / 'arnis-mac-universal-v3.4.0.tar.gz'
    if not archive.exists():
        temporary = archive.with_suffix('.part')
        with urllib.request.urlopen(source['url'], timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        temporary.replace(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != source['sha256']:
        raise ValueError('Official archive checksum mismatch; refusing execution')
    directory = BASE / 'arnis-v3.4.0'
    directory.mkdir(exist_ok=True)
    with tarfile.open(archive) as bundle:
        bundle.extractall(directory, filter='data')
    binary = directory / source['binary']
    binary.chmod(binary.stat().st_mode | 0o100)
    return binary


def generation_command(config, binary, output):
    return [str(binary), '--output-dir=' + str(output),
            '--bbox=' + ','.join(map(str, config['bbox'])), '--scale=1', '--ground-level=62',
            '--mode=geo-terrain', '--interior=true', '--spawn-lat=' + str(config['spawn']['latitude']),
            '--spawn-lng=' + str(config['spawn']['longitude']), '--map-preview', '--signage=none',
            '--map-item=false', '--vanilla-height', '--gamemode=survival', '--world-time=1000',
            '--mapillary-facades=false']


def generate(config):
    record_path = BASE / 'generation-active.json'
    if record_path.exists():
        previous = json.loads(record_path.read_text())
        if previous.get('status') in ('running', 'generated'):
            return previous
    binary = acquire(config)
    run = str(uuid.uuid4())
    directory = BASE / 'generation' / run
    output = directory / 'worlds'
    output.mkdir(parents=True)
    command = generation_command(config, binary, output)
    environment = dict(os.environ)
    environment.pop('MAPILLARY_TOKEN', None)
    record = {'schema': 'agentcity.mumbai-generation.v1', 'runId': run,
              'directory': str(directory), 'command': command, 'status': 'running',
              'startedAt': datetime.now(timezone.utc).isoformat(), 'realMoneySpentUsd': 0}
    with (directory / 'generation.log').open('wb') as log:
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, env=environment)
        record['pid'] = process.pid
        record_path.write_text(json.dumps(record, indent=2) + '\n')
        code = process.wait()
    record.update(exitCode=code, status='generated' if code == 0 else 'failed',
                  completedAt=datetime.now(timezone.utc).isoformat())
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    (directory / 'process.json').write_text(json.dumps(record, indent=2) + '\n')
    if code:
        raise RuntimeError('Arnis failed; inspect the retained generation log')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fetch', 'generate', 'status'])
    args = parser.parse_args()
    config = configuration()
    if args.action == 'fetch':
        print(json.dumps({'verifiedBinary': str(acquire(config))}))
    elif args.action == 'generate':
        print(json.dumps(generate(config)))
    else:
        path = BASE / 'generation-active.json'
        print(path.read_text() if path.exists() else json.dumps({'status': 'not_generated'}))
