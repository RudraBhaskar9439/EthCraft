"""Compile the current plugin against its pinned maintained runtime and dependencies."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.local/plugin-build'


def build():
    config = json.loads((ROOT / 'config/minecraft-runtime.json').read_text())
    runtime = ROOT / config['qualification']['runtime']
    if hashlib.sha256((runtime / 'paper.jar').read_bytes()).hexdigest() != config['artifacts']['paper']['sha256']:
        raise RuntimeError('The pinned maintained Paper runtime is required.')
    libraries = sorted([*runtime.glob('libraries/**/*.jar'), *runtime.glob('versions/**/*.jar')])
    if not libraries:
        raise RuntimeError('The maintained runtime has no bootstrapped libraries.')
    dependency_directory = ROOT / '.local/property-deps'
    dependencies = json.loads((ROOT / 'config/property-dependencies.json').read_text())['artifacts']
    for dependency in dependencies:
        artifact = dependency_directory / dependency['file']
        if not artifact.exists() or hashlib.sha256(artifact.read_bytes()).hexdigest() != dependency['sha256']:
            raise RuntimeError('Verified property dependency required: ' + dependency['file'])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    classes = OUTPUT / 'classes'
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir()
    classpath = ':'.join('/runtime/' + str(path.relative_to(runtime)) for path in libraries)
    classpath += ':' + ':'.join('/property-deps/' + dependency['file'] for dependency in dependencies)
    base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=bind,src={ROOT},dst=/repo,readonly',
            '--mount', f'type=bind,src={runtime},dst=/runtime,readonly',
            '--mount', f'type=bind,src={dependency_directory},dst=/property-deps,readonly',
            '--mount', f'type=bind,src={OUTPUT},dst=/output', config['java_image']]
    sources = sorted((ROOT / 'plugin/src/main/java').rglob('*.java'))
    if not sources:
        raise RuntimeError('Plugin source is absent.')
    command = base + ['javac', '--release', '25', '-proc:none', '-cp', classpath, '-d', '/output/classes']
    result = subprocess.run(command + ['/repo/' + str(path.relative_to(ROOT)) for path in sources], capture_output=True, text=True)
    (OUTPUT / 'compile.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Plugin compilation failed; see .local/plugin-build/compile.log\n' + result.stderr[-8000:])
    for resource in (ROOT / 'plugin/src/main/resources').rglob('*'):
        if resource.is_file():
            target = classes / resource.relative_to(ROOT / 'plugin/src/main/resources')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resource, target)
    result = subprocess.run(base + ['jar', '--create', '--file', '/output/AgentCity.jar', '--manifest',
                                   '/repo/plugin/src/main/resources/META-INF/MANIFEST.MF', '-C', '/output/classes', '.'], capture_output=True, text=True)
    (OUTPUT / 'package.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Plugin packaging failed; see .local/plugin-build/package.log')
    return OUTPUT / 'AgentCity.jar', base, classpath


if __name__ == '__main__':
    artifact, _, _ = build()
    print(artifact.relative_to(ROOT))
