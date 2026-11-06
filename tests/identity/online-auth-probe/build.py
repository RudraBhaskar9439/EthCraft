"""Build only the standalone auth observer; never rebuild the adopted game plugin."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.local/online-auth/build'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    config = json.loads((ROOT / 'config/minecraft-runtime.json').read_text())
    source_hashes = {path.name: sha(path) for path in [HERE / 'AgentCityOnlineAuth.java', HERE / 'plugin.yml', Path(__file__)]}
    directory = OUTPUT / hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest()[:16]
    artifact = directory / 'AgentCityOnlineAuth.jar'
    if artifact.exists():
        manifest = json.loads((directory / 'source-manifest.json').read_text())
        if manifest['sources'] != source_hashes or manifest['jarSha256'] != sha(artifact):
            raise RuntimeError('Cached standalone authentication artifact changed.')
        return artifact, source_hashes
    legacy = ROOT / '.local/compatibility/server'
    jars = sorted([*legacy.glob('libraries/**/*.jar'), *legacy.glob('versions/**/*.jar')])
    if not jars:
        raise RuntimeError('Pinned cached Paper API libraries are required.')
    directory.mkdir(parents=True, exist_ok=True)
    classes = directory / 'classes'; classes.mkdir()
    classpath = ':'.join('/api/' + str(path.relative_to(legacy)) for path in jars)
    base = ['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=bind,src={HERE},dst=/source,readonly', '--mount', f'type=bind,src={legacy},dst=/api,readonly',
            '--mount', f'type=bind,src={directory},dst=/output', config['java_image']]
    compiled = subprocess.run(base + ['javac', '--release', '21', '-proc:none', '-cp', classpath, '-d', '/output/classes', '/source/AgentCityOnlineAuth.java'], capture_output=True, text=True, timeout=60)
    (directory / 'compile.log').write_text(compiled.stdout + compiled.stderr)
    if compiled.returncode:
        raise RuntimeError('Standalone auth probe compilation failed; inspect its private compile log.')
    shutil.copyfile(HERE / 'plugin.yml', classes / 'plugin.yml')
    subprocess.run(base + ['jar', '--create', '--file', '/output/AgentCityOnlineAuth.jar', '-C', '/output/classes', '.'], check=True, capture_output=True, timeout=30)
    (directory / 'source-manifest.json').write_text(json.dumps({'sources': source_hashes, 'jarSha256': sha(artifact)}, indent=2) + '\n')
    return artifact, source_hashes


if __name__ == '__main__':
    artifact, _ = build()
    print(artifact.relative_to(ROOT))
