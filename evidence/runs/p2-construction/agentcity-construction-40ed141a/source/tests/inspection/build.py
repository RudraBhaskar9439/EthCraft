"""Compile the local plugin against the same pinned Paper libraries as P0."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.local/compatibility/server'
OUTPUT = ROOT / '.local/inspection'


def build():
    lock = json.loads((ROOT/'tests/compatibility/versions.json').read_text())
    paper = RUNTIME/'paper.jar'
    if not paper.exists() or hashlib.sha256(paper.read_bytes()).hexdigest() != lock['paper']['sha256']:
        raise RuntimeError('Run the pinned P0 compatibility setup first; Paper checksum is required.')
    jars = sorted([*RUNTIME.glob('libraries/**/*.jar'), *RUNTIME.glob('versions/**/*.jar')])
    if not jars:
        raise RuntimeError('No bootstrapped Paper libraries.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    classes = OUTPUT/'classes'
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir()
    cp = ':'.join('/runtime/'+str(p.relative_to(RUNTIME)) for p in jars)
    base = ['docker','run','--rm','--network','none','--user',f'{os.getuid()}:{os.getgid()}',
            '--mount',f'type=bind,src={ROOT},dst=/repo,readonly',
            '--mount',f'type=bind,src={RUNTIME},dst=/runtime,readonly',
            '--mount',f'type=bind,src={OUTPUT},dst=/output',lock['java_image']]
    sources = sorted((ROOT/'plugin/src/main/java').rglob('*.java'))
    checks = sorted((ROOT/'tests/inspection').rglob('*.java'))
    if not sources:
        raise RuntimeError('Plugin source absent.')
    command = base+['javac','--release','21','-proc:none','-cp',cp,'-d','/output/classes']
    result = subprocess.run(command+['/repo/'+str(p.relative_to(ROOT)) for p in sources],capture_output=True,text=True)
    (OUTPUT/'compile.log').write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError('Plugin compilation failed; see .local/inspection/compile.log\n'+result.stderr[-8000:])
    if checks:
        check_classes = OUTPUT/'checks'
        if check_classes.exists():
            shutil.rmtree(check_classes)
        check_classes.mkdir()
        result = subprocess.run(base+['javac','--release','21','-proc:none','-cp',cp+':/output/classes','-d','/output/checks']+['/repo/'+str(p.relative_to(ROOT)) for p in checks],capture_output=True,text=True)
        (OUTPUT/'compile-checks.log').write_text(result.stdout+result.stderr)
        if result.returncode:
            raise RuntimeError('Core check compilation failed: '+result.stderr[-8000:])
    for p in (ROOT/'plugin/src/main/resources').rglob('*'):
        if p.is_file():
            target=classes/p.relative_to(ROOT/'plugin/src/main/resources')
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(p,target)
    result=subprocess.run(base+['jar','--create','--file','/output/AgentCity.jar','--manifest','/repo/plugin/src/main/resources/META-INF/MANIFEST.MF','-C','/output/classes','.'],capture_output=True,text=True)
    (OUTPUT/'package.log').write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError('Plugin packaging failed: '+result.stderr)
    return OUTPUT/'AgentCity.jar',base,cp


if __name__ == '__main__':
    artifact,_,_=build()
    print(artifact.relative_to(ROOT))
