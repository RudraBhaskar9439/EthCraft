"""Verify local Anvil dump/load in a disposable process; never reset the main chain."""
import gzip
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_host', ROOT / 'scripts/local_host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def rpc(port, method, params=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}), {'Content-Type': 'application/json'})
        value = json.loads(connection.getresponse().read())
        if 'error' in value:
            raise RuntimeError('Local RPC method failed: ' + method)
        return value['result']
    finally:
        connection.close()


def optional(port, method, params):
    try:
        return {'available': True, 'value': rpc(port, method, params)}
    except RuntimeError:
        return {'available': False}


def verify():
    run_id = uuid.uuid4().hex
    directory = host.LOCAL / 'chain-backups' / run_id
    directory.mkdir(parents=True, mode=0o700)
    output = ROOT / 'tests/recovery/runs' / ('anvil-' + run_id) / 'report.json'
    report = {'status': 'fail', 'scope': 'Actual local Anvil dump/load into an isolated loopback process; no main-chain reset or public network',
              'realMoneySpent': 0, 'mainChainModified': False, 'checks': []}
    process = None
    try:
        deployment = json.loads((ROOT / 'contracts/local-deployment.json').read_text())
        assert deployment['environment'] == 'LOCAL_SYNTHETIC_ONLY' and deployment['rpcUrl'] == 'http://127.0.0.1:8547'
        assert rpc(8547, 'eth_chainId') == '0x7a69'
        pointer = json.loads((ROOT / '.local/backend/latest-demo.json').read_text())
        source_report = json.loads(Path(pointer['report']).read_text())
        assert source_report['status'] == 'pass' and source_report['mode'] == 'LOCAL_SYNTHETIC_ONLY'
        transaction_hash = source_report['settlement']['claimTransactionHash']
        receipt = rpc(8547, 'eth_getTransactionReceipt', [transaction_hash])
        transaction = rpc(8547, 'eth_getTransactionByHash', [transaction_hash])
        assert receipt and receipt['status'] == '0x1' and transaction
        block = rpc(8547, 'eth_getBlockByHash', [receipt['blockHash'], False])
        head = rpc(8547, 'eth_getBlockByNumber', ['latest', False])
        genesis = rpc(8547, 'eth_getBlockByNumber', ['0x0', False])
        prior_block = hex(int(receipt['blockNumber'], 16) - 1)
        historical = optional(8547, 'eth_getBalance', [deployment['builder'], prior_block])
        state = rpc(8547, 'anvil_dumpState')
        assert rpc(8547, 'eth_getBlockByNumber', ['latest', False])['hash'] == head['hash'], 'Main chain changed during capture; coordinate a quiet capture.'
        decoded = json.loads(gzip.decompress(bytes.fromhex(state[2:])))
        archive = directory / 'state.hex'
        with archive.open('x') as stream:
            archive.chmod(0o600)
            stream.write(state)
        archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        host.private_json(directory / 'manifest.json', {'scope': report['scope'], 'createdAt': datetime.now(timezone.utc).isoformat(),
                          'sha256': archive_hash, 'sourceBlockHash': head['hash'], 'sourceGenesisHash': genesis['hash'],
                          'sourceReceipt': receipt, 'historicalProbe': historical, 'historicalProbeBlock': prior_block})
        report['checks'].append('main local chain and a successful prior labor-claim receipt identified; dump captured at an unchanged head')
        port = 18547
        if host.occupied(port):
            raise RuntimeError('Isolated recovery port is occupied; its service was not changed.')
        log = directory / 'isolated-anvil.log'
        with log.open('ab') as stream:
            log.chmod(0o600)
            process = subprocess.Popen(['anvil', '--host', '127.0.0.1', '--port', str(port), '--chain-id', '31337', '--no-mining', '--silent'], cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(50):
            try:
                if rpc(port, 'eth_chainId') == '0x7a69':
                    break
            except (OSError, RuntimeError):
                pass
            if process.poll() is not None:
                raise RuntimeError('Isolated Anvil stopped during startup.')
            time.sleep(0.1)
        else:
            raise TimeoutError('Isolated Anvil did not become ready.')
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_hash
        assert rpc(port, 'anvil_loadState', [archive.read_text()]) is True
        restored = json.loads(gzip.decompress(bytes.fromhex(rpc(port, 'anvil_dumpState')[2:])))
        assert restored['accounts'] == decoded['accounts'], 'Restored account balances, nonces, code or storage differ.'
        report['checks'].append('actual anvil_loadState preserves every captured account balance, nonce, contract bytecode and storage slot')
        restored_receipt = rpc(port, 'eth_getTransactionReceipt', [transaction_hash])
        restored_transaction = rpc(port, 'eth_getTransactionByHash', [transaction_hash])
        restored_block = rpc(port, 'eth_getBlockByHash', [receipt['blockHash'], False])
        restored_genesis = rpc(port, 'eth_getBlockByNumber', ['0x0', False])
        restored_historical = optional(port, 'eth_getBalance', [deployment['builder'], prior_block])
        history = {'knownReceiptPreserved': restored_receipt == receipt, 'knownTransactionPreserved': restored_transaction == transaction,
                   'knownBlockPreserved': restored_block == block, 'genesisIdentityPreserved': restored_genesis == genesis,
                   'historicalStatePreserved': historical.get('available') and restored_historical == historical,
                   'historicalStatesIncludedInDump': decoded.get('historical_states') is not None}
        report.update(status='pass', accountCount=len(decoded['accounts']), history=history,
                      requiresReconciliation=not all(history.values()), archiveSha256=archive_hash,
                      backupDirectory=str(directory.relative_to(ROOT)), knownTransactionHash=transaction_hash,
                      sourceReport=str(Path(pointer['report']).relative_to(ROOT)))
        report['checks'].append('receipt, transaction, block, genesis and historical-state availability explicitly compared; missing history requires reconciliation')
        assert rpc(8547, 'eth_getBlockByNumber', ['latest', False])['hash'] == head['hash']
        report['mainHeadUnchanged'] = True
    except Exception as error:
        report['status'] = 'fail'
        report['error'] = {'type': type(error).__name__, 'message': str(error)[:300]}
        raise
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        report['isolatedProcessStopped'] = process is not None and process.poll() is not None
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['sources'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ['ops/chain_recovery.py', 'scripts/local_host.py']}
        output.parent.mkdir(parents=True, exist_ok=False)
        output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'evidence': str(output.relative_to(ROOT)), 'requiresReconciliation': report.get('requiresReconciliation')}))
    return report


if __name__ == '__main__':
    verify()
