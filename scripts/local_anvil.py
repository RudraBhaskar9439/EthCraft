"""Start AgentCity's local EVM and deploy only onto the node this helper started."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
RPC = 'http://127.0.0.1:8547'


def rpc(method, params=None):
    request = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        value = json.load(response)
    if 'error' in value:
        raise RuntimeError(value['error'].get('message', 'Local RPC failed.'))
    return value['result']


def run():
    directory = ROOT / '.local/backend'
    directory.mkdir(parents=True, exist_ok=True)
    started = False
    try:
        chain = rpc('eth_chainId')
    except (OSError, TimeoutError):
        with (directory / 'anvil.log').open('ab') as output:
            process = subprocess.Popen(['anvil', '--host', '127.0.0.1', '--port', '8547', '--chain-id', '31337', '--silent'], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        started = True
        for _ in range(50):
            try:
                chain = rpc('eth_chainId')
                break
            except (OSError, TimeoutError):
                if process.poll() is not None:
                    raise RuntimeError('Owned Anvil stopped; inspect the ignored local log.')
                time.sleep(0.1)
        else:
            raise TimeoutError('Owned Anvil did not become ready.')
    if int(chain, 16) != 31337:
        raise RuntimeError('The existing endpoint is not the local development chain.')
    configuration = ROOT / 'contracts/local-deployment.json'
    existing = json.loads(configuration.read_text()) if configuration.exists() else None
    if existing and rpc('eth_getCode', [existing['jobEscrow'], 'latest']) != '0x':
        if existing.get('environment') != 'LOCAL_SYNTHETIC_ONLY' or existing['rpcUrl'] != RPC:
            raise RuntimeError('Existing deployment identity differs.')
        verification_file = existing.get('verificationFile', 'evidence/runs/local-p5-p8/anvil-deployment-verification.json')
        verification = json.loads((ROOT / verification_file).read_text())
        for name, expected in verification['contracts'].items():
            code = rpc('eth_getCode', [existing[name], 'latest'])
            if existing[name].lower() != expected['address'].lower() or hashlib.sha256(bytes.fromhex(code[2:])).hexdigest() != expected['bytecode_sha256']:
                raise RuntimeError('Existing local contract bytecode differs: ' + name)
        print('Existing local AgentCity EVM and deployment are ready on loopback port 8547.')
        return
    if not started:
        raise RuntimeError('The occupied local node has no verified AgentCity deployment; it will not be modified.')
    accounts = rpc('eth_accounts')
    if len(accounts) < 7:
        raise RuntimeError('Seven distinct local fixture accounts are required.')
    roles = dict(zip(['LOCAL_ADMIN', 'LOCAL_WAREHOUSE', 'LOCAL_PUBLISHER', 'LOCAL_ATTESTOR', 'LOCAL_REQUESTER', 'LOCAL_BUILDER', 'LOCAL_ISSUER'], accounts[:7]))
    candidate = ROOT / 'contracts/.local/deployment-candidate.json'
    candidate.parent.mkdir(parents=True, exist_ok=True)
    verification_file = 'evidence/runs/local-p5-p8-bootstrap-' + uuid.uuid4().hex + '/anvil-deployment-verification.json'
    with (directory / 'local-deployment.log').open('w') as output:
        subprocess.run(['forge', 'script', 'script/LocalDeploy.s.sol:LocalDeploy', '--rpc-url', RPC, '--unlocked', '--broadcast', '--slow', '--sender', accounts[0]], cwd=ROOT / 'contracts', env=dict(os.environ, **roles, LOCAL_DEPLOYMENT_OUTPUT='.local/deployment-candidate.json'), stdout=output, stderr=subprocess.STDOUT, check=True)
        subprocess.run(['node', 'scripts/local_verify_contract_deployment.mjs', str(candidate.relative_to(ROOT)), verification_file, '--fresh'], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
    deployment = json.loads(candidate.read_text())
    deployment.update({'rpcUrl': RPC, 'accounts': accounts, 'localFixtureOnly': True})
    deployment['verificationFile'] = verification_file
    configuration.write_text(json.dumps(deployment, indent=2) + '\n')
    pointer = directory / 'liquidity-seed.json'
    if pointer.exists():
        pointer.rename(directory / ('liquidity-seed-previous-' + uuid.uuid4().hex + '.json'))
    (directory / 'anvil-environment.json').write_text(json.dumps({'pid': process.pid, 'rpcUrl': RPC, 'chainId': 31337, 'localFixtureOnly': True}, indent=2) + '\n')
    print('Owned local Anvil and AgentCity contracts are ready; no public network was contacted.')


if __name__ == '__main__':
    run()
