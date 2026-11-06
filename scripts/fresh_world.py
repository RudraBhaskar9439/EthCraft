"""Run a new loopback calculator demonstration without migrating historical host state.

Run under WSL on Windows. This uses disclosed local fixture identities and synthetic
operator access infrastructure; it does not approve a phase or authenticate humans.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local/fresh-world'
ACTIVE = BASE / 'active.json'
OWNER = 'agentcity-fresh-local-world'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def run(args, **options):
    return subprocess.run(args, cwd=ROOT, check=True, **options)


def owned(data):
    actual = json.loads(run(['docker', 'inspect', data['container']], capture_output=True, text=True).stdout)[0]
    expected = {'25565/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25596'}],
                '25578/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '25597'}]}
    if (actual['Config']['Labels'].get('agentcity.owner') != data['owner']
            or actual['HostConfig']['PortBindings'] != expected
            or actual['Config']['Image'] != data['javaImage']):
        raise RuntimeError('Fresh-world ownership, image or loopback bindings differ.')
    return actual


def prepare(visitor):
    if ACTIVE.exists():
        data = load(ACTIVE)
        if visitor != data['visitor']:
            raise RuntimeError('Existing world has another visitor; it was not changed.')
        return data
    if not re.fullmatch(r'[A-Za-z0-9_]{3,16}', visitor):
        raise ValueError('A Minecraft username of 3 to 16 letters, digits or underscores is required.')
    if visitor in {'WorldBuilder', 'WorldRequester', 'WorldInspector'}:
        raise ValueError('The visitor must be distinct from the disclosed fixture actors.')
    for port in [25596, 25597]:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    boundary = module('fresh_world_boundary', 'tests/inspection/run.py')
    configuration = load(ROOT / 'config/minecraft-runtime.json')
    artifact, _, _ = boundary.builder.build()
    identifier = 'agentcity-fresh-' + uuid.uuid4().hex[:8]
    runtime = BASE / identifier
    runtime.mkdir(parents=True, mode=0o700)
    plugins = runtime / 'plugins'
    data_directory = plugins / 'AgentCity'
    data_directory.mkdir(parents=True)
    shutil.copyfile(artifact, plugins / 'AgentCity.jar')
    for key, destination in [('paper', runtime / 'paper.jar'),
                             ('ViaVersion', plugins / 'ViaVersion.jar'),
                             ('ViaBackwards', plugins / 'ViaBackwards.jar')]:
        source = ROOT / 'tests/compatibility/maintained-candidate/.cache' / (key + '.jar')
        if sha(source) != configuration['artifacts'][key]['sha256']:
            raise RuntimeError('Pinned artifact checksum differs: ' + key)
        shutil.copyfile(source, destination)
    # Paper's embedded download context supplies the exact official vanilla hash.
    with zipfile.ZipFile(runtime / 'paper.jar') as jar:
        digest, url, filename = jar.read('META-INF/download-context').decode().strip().split()
    if not url.startswith('https://piston-data.mojang.com/v1/objects/'):
        raise RuntimeError('Unexpected Paper vanilla download origin.')
    cache = runtime / 'cache'
    cache.mkdir()
    vanilla = cache / filename
    run(['curl', '--fail', '--silent', '--show-error', '--max-time', '180',
         url.replace('https://piston-data.mojang.com/', 'https://launcher-cdn.azureedge.net/'),
         '--output', str(vanilla)])
    if sha(vanilla) != digest:
        raise RuntimeError('Vanilla server checksum differs from Paper embedded metadata.')
    blueprint = ROOT / 'fixtures/blueprints/calculator-v1.json'
    tests = ROOT / 'fixtures/test-manifests/calculator-v1.json'
    access = ROOT / 'fixtures/construction/access-v1.json'
    for source, name in [(blueprint, 'blueprint.json'), (tests, 'tests.json'), (access, 'construction-access.json')]:
        shutil.copyfile(source, data_directory / name)
    deployment = boundary.deployment(identifier, blueprint, tests, int(time.time() * 1000) + 21600000)
    deployment['constructionAccessSha256'] = sha(access)
    save(data_directory / 'deployment.json', deployment)
    (data_directory / 'bootstrap-grant').write_text(identifier + '\n' + sha(data_directory / 'deployment.json') + '\n')
    plan = {'schema': 'agentcity.construction-fixture.v1', 'purpose': 'isolated_non_token_p2_construction',
            'run_id': identifier, 'deployment': deployment, 'blueprint': load(blueprint),
            'construction_access': load(access), 'scenario': 'build', 'material_bill': load(blueprint)['material_bill'],
            'withheld_stock': {}, 'operator_reserve_chest': None, 'occupied_target_relative': None,
            'blocked_access_relative': None, 'final_circuit_seeded': False, 'post_bootstrap_mutation_api': False}
    save(runtime / 'construction-fixture.json', plan)
    source_directory = runtime / 'fixture-source'
    source_directory.mkdir()
    source = (ROOT / 'tests/construction/fixture/ConstructionFixture.java').read_text()
    original = 'if (!NAMES.contains(player.getName())) { player.kickPlayer("Local construction fixture identities only"); return; }'
    replacement = ('if (player.getName().equals("' + visitor + '")) { player.setOp(false); '
                   'player.setGameMode(GameMode.SPECTATOR); player.teleport(new Location(world, 8.5, 88, 5.5)); return; }\n        ' + original)
    if source.count(original) != 1:
        raise RuntimeError('Visitor fixture source changed; review before creating a world.')
    source = source.replace(original, replacement)
    resume_source = 'resumeMode = Boolean.getBoolean("agentcity.localConstructionResume");'
    if source.count(resume_source) != 1:
        raise RuntimeError('Fixture resume guard changed; review before creating a world.')
    # A persistent host resumes its own marked world; it never replenishes stock.
    source = source.replace(resume_source, 'resumeMode = Files.exists(marker);')
    (source_directory / 'ConstructionFixture.java').write_text(source)
    legacy = ROOT / '.local/compatibility/server'
    libraries = sorted([*legacy.glob('libraries/**/*.jar'), *legacy.glob('versions/**/*.jar')])
    classpath = ':'.join('/legacy/' + str(path.relative_to(legacy)) for path in libraries)
    classes = runtime / 'fixture-classes'
    classes.mkdir()
    image = load(ROOT / 'tests/compatibility/versions.json')['java_image']
    base = ['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=bind,src={runtime},dst=/world', '--mount', f'type=bind,src={legacy},dst=/legacy,readonly', image]
    run(base + ['javac', '--release', '21', '-proc:none', '-cp', classpath, '-d', '/world/fixture-classes', '/world/fixture-source/ConstructionFixture.java'])
    shutil.copyfile(ROOT / 'tests/construction/fixture/plugin.yml', classes / 'plugin.yml')
    run(base + ['jar', '--create', '--file', '/world/plugins/AgentCityConstructionFixture.jar', '-C', '/world/fixture-classes', '.'])
    (runtime / 'eula.txt').write_text('# Owner requested this private local world. https://www.minecraft.net/eula\neula=true\n')
    properties = boundary.p0.server_properties().replace('level-name=compatibility-world', 'level-name=' + identifier)
    properties = properties.replace('max-players=3', 'max-players=4').replace('white-list=false', 'white-list=true')
    (runtime / 'server.properties').write_text(properties)
    save(runtime / 'whitelist.json', [{'uuid': boundary.offline_uuid(name), 'name': name}
         for name in ['WorldBuilder', 'WorldRequester', 'WorldInspector', visitor]])
    token = secrets.token_urlsafe(48)
    (runtime / 'api-token').write_text(token)
    (runtime / 'api-token').chmod(0o600)
    data = {'owner': OWNER, 'container': identifier, 'runtime': str(runtime), 'visitor': visitor,
            'javaImage': configuration['java_image'], 'pluginSha256': sha(plugins / 'AgentCity.jar'),
            'fixtureSha256': sha(plugins / 'AgentCityConstructionFixture.jar'), 'phaseApproval': False,
            'independentHumansVerified': 0, 'tokenIntegration': False}
    save(ACTIVE, data)
    return data


def start(data):
    runtime = Path(data['runtime'])
    if not runtime.resolve().is_relative_to(BASE.resolve()):
        raise RuntimeError('Fresh-world directory is outside its owned base.')
    existing = subprocess.run(['docker', 'inspect', data['container']], capture_output=True)
    if existing.returncode == 0:
        actual = owned(data)
        if not actual['State']['Running']:
            run(['docker', 'start', data['container']], capture_output=True)
    else:
        resume = ['-Dagentcity.localConstructionResume=true'] if (runtime / 'fixture-initialized').exists() else []
        run(['docker', 'run', '--detach', '--pull', 'never', '--name', data['container'],
             '--label', 'agentcity.owner=' + data['owner'], '--publish', '127.0.0.1:25596:25565',
             '--publish', '127.0.0.1:25597:25578', '--env', 'AGENTCITY_API_TOKEN',
             '--mount', f'type=bind,src={runtime},dst=/server', '--workdir', '/server',
             '--user', f'{os.getuid()}:{os.getgid()}', '--memory', '2g', '--cpus', '2', data['javaImage'],
             'java', '-Xms512M', '-Xmx1536M', '-Dagentcity.localFixture=true', *resume, '-jar', 'paper.jar', '--nogui'],
            env=dict(os.environ, AGENTCITY_API_TOKEN=(runtime / 'api-token').read_text()), capture_output=True)
    for _ in range(240):
        try:
            return status(data)
        except (OSError, ValueError, http.client.HTTPException):
            if not owned(data)['State']['Running']:
                raise RuntimeError('Fresh server stopped; inspect docker logs ' + data['container'])
            time.sleep(1)
    raise TimeoutError('Fresh server did not become ready.')


def ensure_inference():
    connection = http.client.HTTPConnection('127.0.0.1', 11434, timeout=3)
    try:
        connection.request('GET', '/api/tags')
        response = connection.getresponse()
        if response.status == 200:
            return
        raise RuntimeError('Existing WSL inference endpoint is unhealthy; it was not changed.')
    except OSError:
        if not Path('/mnt/c/Windows/System32/curl.exe').is_file():
            raise RuntimeError('Start loopback Ollama before building the calculator.')
        with (BASE / 'ollama-bridge.log').open('ab') as output:
            subprocess.Popen(['python3', str(ROOT / 'scripts/ollama_wsl_bridge.py')],
                             stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        connection.close()


def status(data):
    actual = owned(data)
    if not actual['State']['Running']:
        raise RuntimeError('Fresh server is stopped.')
    connection = http.client.HTTPConnection('127.0.0.1', 25597, timeout=3)
    try:
        connection.request('GET', '/status', headers={'Authorization': 'Bearer ' + (Path(data['runtime']) / 'api-token').read_text()})
        response = connection.getresponse()
        if response.status != 200:
            raise OSError('Plugin status is not ready.')
        state = json.loads(response.read())['state']
    finally:
        connection.close()
    return {'ready': True, 'address': '127.0.0.1:25596', 'visitor': data['visitor'],
            'visitorMode': 'spectator', 'container': data['container'], 'revision': state['revision'],
            'phaseApproval': False, 'tokenIntegration': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status'])
    parser.add_argument('--visitor', default='Ruddy')
    args = parser.parse_args()
    if os.name != 'posix':
        raise SystemExit('Run this helper under WSL; the plugin build requires Unix Docker paths.')
    if args.action == 'start':
        result = start(prepare(args.visitor))
        ensure_inference()
    else:
        result = status(load(ACTIVE))
    print(json.dumps(result, indent=2))
