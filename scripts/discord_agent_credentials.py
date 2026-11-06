"""Provision private credentials for real, separately created Discord applications."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlencode

SCHEMA = 'agentcity.discord-agent-credentials.v1'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, default=Path.home() / '.config/agentcity/discord-agent-credentials.json')
    parser.add_argument('--agent', help='Registered agent identifier, for example CityAgent1')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--invite', action='store_true')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('Run inside WSL; credentials require private Unix storage.')
    file = args.file.expanduser().absolute()
    state = json.loads(file.read_text()) if file.exists() else {'schema': SCHEMA, 'agents': {}}
    if state.get('schema') != SCHEMA:
        parser.error('Credential schema mismatch.')
    if args.list or args.invite:
        for name, value in state['agents'].items():
            output = {'agent': name, 'applicationId': value['applicationId'], 'tokenConfigured': bool(value.get('botToken'))}
            if args.invite:
                # Layout is managed by the coordinator; these bots never need ManageChannels.
                output['invite'] = 'https://discord.com/oauth2/authorize?' + urlencode({'client_id': value['applicationId'], 'scope': 'bot applications.commands', 'permissions': '117760'})
            print(json.dumps(output))
        return
    if not args.agent or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', args.agent):
        parser.error('Supply --agent with a registered agent identifier.')
    application_id = input('Dedicated Discord application ID (public): ').strip()
    if not re.fullmatch(r'[0-9]{5,22}', application_id):
        parser.error('Application ID invalid.')
    token = getpass.getpass('Dedicated bot token (hidden, never paste in chat): ').strip()
    if len(token) < 30 or re.search(r'\s', token):
        parser.error('Bot token invalid.')
    if any(name != args.agent and (value['applicationId'] == application_id or value['botToken'] == token) for name, value in state['agents'].items()):
        parser.error('Every agent requires a distinct bot application and token.')
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if file.parent.stat().st_uid != os.getuid() or file.parent.stat().st_mode & 0o077:
        parser.error('Credential parent must be owned by you and mode700.')
    if file.exists() and (file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o077):
        parser.error('Existing credential file must be owned by you and mode600.')
    state['agents'][args.agent] = {'applicationId': application_id, 'botToken': token}
    temporary = file.with_name(file.name + '.' + secrets.token_hex(8) + '.pending')
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(json.dumps(state, indent=2) + '\n')
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)
    print('Private credentials saved. Restart only the owned Discord service after review; no applications or invitations were created.')

if __name__ == '__main__':
    main()
