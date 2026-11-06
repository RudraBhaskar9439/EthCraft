"""Compile a clearly labelled candidate copy; production sources remain unchanged."""
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('candidate_build_helpers', ROOT / 'tests/compatibility/run.py')
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)
sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()


def build():
    original = ROOT / 'evidence/runs/minecraft-internal/agentcity-construction-750b0aae/source/plugin'
    source = HERE / 'candidate-src/plugin'
    if not source.exists():
        shutil.copytree(original, source)
        main = source / 'src/main/java/org/agentcity/paper/AgentCityPlugin.java'
        text = main.read_text()
        before = 'if(!Bukkit.getMinecraftVersion().equals("1.21.11"))throw new IllegalStateException("unsupported_game_version");'
        after = 'if(!java.util.Set.of("1.21.11","26.3").contains(Bukkit.getMinecraftVersion()))throw new IllegalStateException("unsupported_game_version");'
        assert text.count(before) == 1
        main.write_text(text.replace(before, after))
    originals = {str(file.relative_to(original)): sha(file) for file in sorted(original.rglob('*')) if file.is_file()}
    candidates = {str(file.relative_to(source)): sha(file) for file in sorted(source.rglob('*')) if file.is_file()}
    patches = []
    for relative in originals:
        patches.extend(difflib.unified_diff((original / relative).read_text().splitlines(True), (source / relative).read_text().splitlines(True), fromfile='production/plugin/' + relative, tofile='candidate/plugin/' + relative))
    (HERE / 'candidate.patch').write_text(''.join(patches))
    manifest = {'purpose': 'Candidate source only; not production adoption', 'original_source_sha256': originals, 'candidate_source_sha256': candidates,
        'compiler_java_image': json.loads((ROOT / 'tests/compatibility/versions.json').read_text())['java_image'], 'class_file_release': 21, 'compile_api': 'historical Paper1.21.11 pinned API; actual26.3 native linkage tested separately'}
    artifact = HERE / '.cache/AgentCity-candidate.jar'
    previous_file = HERE / 'source-manifest.json'
    if previous_file.exists() and artifact.exists():
        previous = json.loads(previous_file.read_text())
        if all(previous.get(key) == manifest[key] for key in ['original_source_sha256', 'candidate_source_sha256', 'compiler_java_image', 'class_file_release']) and previous.get('candidate_jar_sha256') == sha(artifact):
            return artifact, previous
    (HERE / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    cache = HERE / '.cache'; cache.mkdir(exist_ok=True)
    classes = cache / 'candidate-classes'
    if classes.exists(): shutil.rmtree(classes)
    classes.mkdir()
    legacy = ROOT / '.local/compatibility/server'
    jars = sorted([*legacy.glob('libraries/**/*.jar'), *legacy.glob('versions/**/*.jar')])
    classpath = ':'.join('/legacy/' + str(file.relative_to(legacy)) for file in jars)
    base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}', '--mount', f'type=bind,src={source},dst=/source,readonly', '--mount', f'type=bind,src={legacy},dst=/legacy,readonly', '--mount', f'type=bind,src={cache},dst=/output', manifest['compiler_java_image']]
    files = sorted((source / 'src/main/java').rglob('*.java'))
    p0.command(base + ['javac', '--release', '21', '-proc:none', '-cp', classpath, '-d', '/output/candidate-classes'] + ['/source/' + str(file.relative_to(source)) for file in files], timeout=90, log_path=cache / 'compile-candidate.log')
    for file in (source / 'src/main/resources').rglob('*'):
        if file.is_file():
            target = classes / file.relative_to(source / 'src/main/resources'); target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(file, target)
    p0.command(base + ['jar', '--create', '--file', '/output/AgentCity-candidate.jar', '--manifest', '/source/src/main/resources/META-INF/MANIFEST.MF', '-C', '/output/candidate-classes', '.'], timeout=30, log_path=cache / 'package-candidate.log')
    manifest['candidate_jar_sha256'] = sha(cache / 'AgentCity-candidate.jar')
    (HERE / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return cache / 'AgentCity-candidate.jar', manifest


if __name__ == '__main__':
    artifact, manifest = build()
    print(json.dumps({'candidateJar': str(artifact), 'sha256': manifest['candidate_jar_sha256']}))
