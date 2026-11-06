"""Store laptop Discord/Privy identity credentials without contacting either service."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.parse import urlsplit


def read_object(path):
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError('Configuration must be owned by the current user and not a symlink.')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('Existing configuration must be a JSON object.')
    return value


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Credential directories must be owned by you and mode700.')


def existing_credentials(path, referenced):
    if not path.is_absolute():
        raise ValueError('Credential paths must be absolute.')
    if not referenced:
        if path.exists():
            raise ValueError('An unreferenced credential file already exists; review it before setup.')
        return None
    value = read_object(path)
    if value is None or path.stat().st_mode & 0o077 or path.parent.stat().st_mode & 0o077 or path.parent.stat().st_uid != os.getuid():
        raise ValueError('Existing credentials require an owned mode600 file in a mode700 directory.')
    return value


def secret_value(value, existing, field, minimum):
    value = value.strip() or (existing or {}).get(field, '')
    if not isinstance(value, str) or not minimum <= len(value) <= 512 or re.search(r'\s', value) or re.match(r'(?i)^(paste|your[_ -]|replace|placeholder|example|changeme)', value):
        raise ValueError('A complete non-placeholder private credential is required.')
    if existing is not None and existing.get(field) != value:
        raise ValueError('Existing private credentials differ; this helper never replaces current keys.')
    return value


def read_private_env(path):
    info, parent = path.lstat(), path.parent.lstat()
    if path.is_symlink() or path.parent.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or parent.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError('Environment input requires an owned mode600 file in an owned mode700 directory.')
    if info.st_size > 8192:
        raise ValueError('Environment input is too large.')
    allowed = {'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'PRIVY_APP_ID', 'DISCORD_BOT_TOKEN', 'PRIVY_APP_SECRET', 'DISCORD_ORIGIN', 'AGENTCITY_SERVER_ID',
               'DISCORD_AGENT1_APPLICATION_ID', 'DISCORD_AGENT1_BOT_TOKEN'}
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        name, value = name.strip(), value.strip()
        if not separator or name not in allowed or name in values:
            raise ValueError('Environment input contains an unknown, duplicate or malformed field.')
        if value[:1] in ['"', "'"]:
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError('Environment quotes must match; shell expressions are never evaluated.')
            value = value[1:-1]
        values[name] = value
    for name in ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'PRIVY_APP_ID', 'DISCORD_BOT_TOKEN', 'PRIVY_APP_SECRET']:
        if not values.get(name):
            raise ValueError('Missing nonempty required environment field: ' + name)
    return values


def configure_from_env(root, home, options):
    values = read_private_env(Path(options.env_file).expanduser().absolute())
    public = {'application_id': 'DISCORD_APPLICATION_ID', 'guild_id': 'DISCORD_GUILD_ID', 'privy_app_id': 'PRIVY_APP_ID',
              'origin': 'DISCORD_ORIGIN', 'server_id': 'AGENTCITY_SERVER_ID'}
    for argument, name in public.items():
        current, imported = getattr(options, argument), values.get(name)
        if current is not None and imported and current != imported:
            raise ValueError('A public CLI argument conflicts with the environment input: ' + name)
        setattr(options, argument, current or imported)
    options.origin = options.origin or 'http://127.0.0.1:8789'
    secrets = iter([values['DISCORD_BOT_TOKEN'], values['PRIVY_APP_SECRET']])
    return configure(root, home, options, ask=lambda _: next(secrets))


def atomic_files(entries):
    """Publish the Discord enable flag last; roll back normal write failures."""
    staged, snapshots, published = {}, {}, []
    try:
        for path, value in entries:
            private_directory(path.parent)
            snapshots[path] = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None
            descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.pending', dir=path.parent)
            staged[path] = Path(temporary)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                json.dump(value, output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
        for path, _ in entries:
            prior = snapshots[path]
            if (path.exists() != (prior is not None)) or prior is not None and path.read_bytes() != prior[0]:
                raise ValueError('A configuration changed during setup; no concurrent overwrite is permitted.')
            os.replace(staged[path], path)
            published.append(path)
    except BaseException:
        for path in reversed(published):
            prior = snapshots[path]
            if prior is None:
                path.unlink()
            else:
                descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.rollback', dir=path.parent)
                with os.fdopen(descriptor, 'wb') as output:
                    output.write(prior[0]); output.flush(); os.fsync(output.fileno())
                os.chmod(temporary, prior[1])
                os.replace(temporary, path)
        raise
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)


def configure(root, home, options, ask=getpass.getpass):
    for key in ['application_id', 'guild_id']:
        if not re.fullmatch(r'[1-9][0-9]{4,21}', getattr(options, key)):
            raise ValueError('Discord application and guild IDs must be public numeric snowflakes.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', options.privy_app_id):
        raise ValueError('A valid public Privy app ID is required.')
    origin = urlsplit(options.origin)
    if not origin.hostname or options.origin != f'{origin.scheme}://{origin.netloc}' or origin.username or origin.password or origin.scheme != 'https' and not (origin.scheme == 'http' and origin.hostname in ['127.0.0.1', 'localhost', '::1']):
        raise ValueError('Use one HTTPS origin or a loopback HTTP origin without a path.')
    discord_path = root / '.local/discord/settings.json'
    wallet_path = root / '.local/playable-testnet/wallet-settings.json'
    discord, wallet = read_object(discord_path), read_object(wallet_path)
    server_id = options.server_id
    if not server_id:
        active = read_object(root / '.local/playable-world/active.json') or {}
        server_id = active.get('serverId')
    if not isinstance(server_id, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', server_id):
        raise ValueError('Use the canonical active server ID or supply --server-id.')
    if discord and any(discord.get(key) != value for key, value in [('applicationId', options.application_id), ('guildId', options.guild_id), ('origin', options.origin), ('serverId', server_id)]):
        raise ValueError('Existing Discord configuration belongs to another application, guild, origin or server.')
    if wallet and (wallet.get('provider') != 'privy' or wallet.get('appId') != options.privy_app_id or wallet.get('playerOrigin', options.origin) != options.origin):
        raise ValueError('Existing Privy settings are incompatible; no funded identity or policy will be replaced.')
    bot_file = Path((discord or {}).get('credentialsFile') or home / '.config/agentcity/discord/bot.json')
    privy_file = Path((wallet or {}).get('credentialsFile') or home / '.config/agentcity/privy/identity.json')
    bot = existing_credentials(bot_file, bool(discord))
    privy = existing_credentials(privy_file, bool(wallet))
    token = secret_value(ask('Discord bot token (hidden; blank keeps a compatible existing token): '), bot, 'botToken', 30)
    if not re.fullmatch(r'[A-Za-z0-9._-]+', token):
        raise ValueError('Discord bot token format is invalid.')
    app_secret = secret_value(ask('Privy app secret (hidden; blank keeps a compatible existing secret): '), privy, 'appSecret', 16)
    # No directory, credential or settings write occurs before both secrets validate.
    entries = []
    if bot is None:
        private_directory(home / '.config/agentcity')
        entries.append((bot_file, {'botToken': token}))
    if privy is None:
        private_directory(home / '.config/agentcity')
        entries.append((privy_file, {'appSecret': app_secret}))
    wallet_settings = {**(wallet or {}), 'provider': 'privy', 'appId': options.privy_app_id, 'playerOrigin': options.origin, 'credentialsFile': str(privy_file)}
    discord_settings = {**(discord or {}), 'applicationId': options.application_id, 'guildId': options.guild_id,
                        'origin': options.origin, 'serverId': server_id, 'credentialsFile': str(bot_file), 'enabled': True}
    entries.extend([(wallet_path, wallet_settings), (discord_path, discord_settings)])
    atomic_files(entries)
    return {'discordSettings': str(discord_path), 'privySettings': str(wallet_path), 'identityOnly': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', help='Import a private literal NAME=value file without shell evaluation.')
    parser.add_argument('--application-id')
    parser.add_argument('--guild-id')
    parser.add_argument('--privy-app-id')
    parser.add_argument('--origin')
    parser.add_argument('--server-id')
    options = parser.parse_args()
    if os.name != 'posix':
        parser.error('Run this helper on macOS or Linux.')
    if not options.env_file and not all([options.application_id, options.guild_id, options.privy_app_id]):
        parser.error('--application-id, --guild-id and --privy-app-id are required unless --env-file is used.')
    try:
        root, home = Path(__file__).resolve().parents[1], Path.home()
        if options.env_file:
            configure_from_env(root, home, options)
        else:
            options.origin = options.origin or 'http://127.0.0.1:8789'
            configure(root, home, options)
    except (ValueError, OSError) as error:
        print('Setup refused: ' + str(error), file=sys.stderr)
        return 1
    print('Discord and Privy identity credentials saved privately. No services were contacted or started.')
    print('Existing wallets, signing policies and model budgets were preserved. Managed-wallet funding/signing is not configured by this helper.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
