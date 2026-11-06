"""Interactive private Discord token storage. Run in WSL; never prints the token."""
import getpass
import json
import os
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if os.name != 'posix':
    raise SystemExit('Run this helper through the supplied Windows command, which uses WSL private storage.')
base = Path.home() / '.config/agentcity/discord'
base.mkdir(parents=True, exist_ok=True, mode=0o700)
base.chmod(0o700)
private = base / 'bot.json'
token = getpass.getpass('Paste the Discord BOT TOKEN (input hidden): ').strip()
if len(token) < 30 or re.search(r'\s', token):
    raise SystemExit('That is not a valid bot-token format. No configuration was changed.')
temporary = base / 'bot.pending.json'
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w') as output:
    json.dump({'botToken': token}, output)
    output.flush(); os.fsync(output.fileno())
temporary.chmod(0o600)
temporary.replace(private)
settings_path = root / '.local/discord/settings.json'
pending_path = root / '.local/discord/settings.pending.json'
settings = json.loads((settings_path if settings_path.exists() else pending_path).read_text())
settings['credentialsFile'] = str(private)
settings['enabled'] = True
if not re.fullmatch(r'[0-9]{5,22}', settings.get('guildId', '')):
    guild = input('Discord SERVER ID (public): ').strip()
    if not re.fullmatch(r'[0-9]{5,22}', guild): raise SystemExit('Server ID is missing. The token was stored privately; rerun after obtaining the Server ID.')
    settings['guildId'] = guild
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(settings, indent=2) + '\n')
print('Bot token saved privately. Public configuration is ready. No token was displayed or sent to chat.')
