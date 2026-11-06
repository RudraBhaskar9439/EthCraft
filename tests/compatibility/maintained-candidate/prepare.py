"""Pin one official maintained candidate; never change the historical production lock."""
import hashlib
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent
HEADERS = {'User-Agent': 'AgentCity/0.1 (isolated non-token compatibility investigation)'}
ARTIFACTS = {
    'paper': {'version': '26.3', 'build': 231, 'sha256': 'a836a016be7ac52352eb3a1efb6857bb42ee73a6c78d46e292f7e87742edb0e6', 'url': 'https://fill-data.papermc.io/v1/objects/a836a016be7ac52352eb3a1efb6857bb42ee73a6c78d46e292f7e87742edb0e6/paper-26.3-231.jar'},
    'ViaVersion': {'version': '5.12.2', 'sha256': '24e4876fefe73e08a4c87cd6c457ee0916e62dd69656631caf41e26f909d504b', 'url': 'https://github.com/ViaVersion/ViaVersion/releases/download/5.12.2/ViaVersion-5.12.2.jar'},
    'ViaBackwards': {'version': '5.12.2', 'sha256': '9a148a80ea22074f4bd1626cdbe254a4cd998bf44e7ceaff4e285a1b6b35da42', 'url': 'https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.2/ViaBackwards-5.12.2.jar'},
}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=90) as response:
        return response.read()


def prepare():
    cache, official = HERE / '.cache', HERE / 'official'
    cache.mkdir(exist_ok=True)
    official.mkdir(exist_ok=True)
    for name, url in {
        'paper-version.json': 'https://fill.papermc.io/v3/projects/paper/versions/26.3',
        'paper-build.json': 'https://fill.papermc.io/v3/projects/paper/versions/26.3/builds/231',
        'ViaVersion-release.json': 'https://api.github.com/repos/ViaVersion/ViaVersion/releases/tags/5.12.2',
        'ViaBackwards-release.json': 'https://api.github.com/repos/ViaVersion/ViaBackwards/releases/tags/5.12.2',
        'Paper-LICENSE.md': 'https://raw.githubusercontent.com/PaperMC/Paper/8a170a38c6811b0a6c82f858da4ff67191c08970/LICENSE.md',
        'ViaVersion-GPL.md': 'https://raw.githubusercontent.com/ViaVersion/ViaVersion/5.12.2/licenses/GPL.md',
        'ViaVersion-API-MIT.md': 'https://raw.githubusercontent.com/ViaVersion/ViaVersion/5.12.2/licenses/MIT.md',
        'ViaBackwards-LICENSE': 'https://raw.githubusercontent.com/ViaVersion/ViaBackwards/5.12.2/LICENSE',
        'ViaBackwards-platform.java': 'https://raw.githubusercontent.com/ViaVersion/ViaBackwards/5.12.2/common/src/main/java/com/viaversion/viabackwards/api/ViaBackwardsPlatform.java',
    }.items():
        path = official / name
        if not path.exists():
            path.write_bytes(fetch(url))
    version = json.loads((official / 'paper-version.json').read_text())['version']
    build = json.loads((official / 'paper-build.json').read_text())
    assert version['support']['status'] == 'SUPPORTED' and version['java']['version']['minimum'] == 25
    assert build['channel'] == 'STABLE' and build['id'] == 231
    assert build['downloads']['server:default']['checksums']['sha256'] == ARTIFACTS['paper']['sha256']
    for name in ['ViaVersion', 'ViaBackwards']:
        release = json.loads((official / (name + '-release.json')).read_text())
        assert not release['prerelease'] and not release['draft']
        asset = next(asset for asset in release['assets'] if asset['name'] == name + '-5.12.2.jar')
        assert asset['digest'] == 'sha256:' + ARTIFACTS[name]['sha256']
    for name, item in ARTIFACTS.items():
        target = cache / (name + '.jar')
        if not target.exists():
            temporary = target.with_suffix('.download')
            temporary.write_bytes(fetch(item['url']))
            assert hashlib.sha256(temporary.read_bytes()).hexdigest() == item['sha256'], name + ' checksum mismatch'
            temporary.rename(target)
        assert hashlib.sha256(target.read_bytes()).hexdigest() == item['sha256']
    manifest = {'purpose': 'isolated_maintained_candidate_not_adopted', 'artifacts': ARTIFACTS, 'server_java_minimum': 25,
        'java_image': 'eclipse-temurin@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507', 'java_runtime': 'Temurin25.0.5+8',
        'licenses': {'Paper': 'GPL-3.0 and bundled upstream notices', 'ViaVersion_plugin': 'GPL-3.0-only', 'ViaVersion_API_only': 'MIT', 'ViaBackwards': 'GPL-3.0-only', 'Temurin_JDK': 'GPL-2.0-only WITH Classpath-exception-2.0', 'container_build_scripts': 'Apache-2.0', 'complete_container': 'Mixed JDK, Ubuntu and third-party licenses; bundled JDK notices retained'},
        'client': '1.21.11', 'mineflayer': '4.39.0', 'pathfinder': '2.4.5', 'bind': '127.0.0.1', 'ports': [25596, 25597],
        'non_token': True, 'production_adopted': False,
        'official_source_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(official.iterdir())}}
    (HERE / 'candidate.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Pinned maintained Paper26.3 build231 and official Via5.12.2 artifacts; candidate only.')


if __name__ == '__main__':
    prepare()
