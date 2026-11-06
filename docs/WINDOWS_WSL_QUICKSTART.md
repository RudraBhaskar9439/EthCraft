# Quick access: existing Windows + WSL host

For someone given access to **this already configured Windows machine**. Use the Windows account that owns the existing Ubuntu installation. Keep the laptop plugged in and connected. No reinstall, fresh clone or new wallet setup is needed.

## 1. Open the project in Windows

Open **Windows Terminal → PowerShell** and run:

```powershell
Set-Location 'C:\Users\Rudransh Shinghal\agentcity-minecraft'
wsl --list --verbose
node --version
git --version
docker version --format '{{.Client.Version}} / {{.Server.Version}}'
```

Expected: **Ubuntu, WSL version 2**, Windows Node **v26.3.1**, Git installed and both Docker client/server versions available. Open Docker Desktop if it is stopped; if Docker already responds, leave it running. Windows Docker is the working engine; do not repair/reset the separate WSL Docker socket.

Open this same folder in your editor. The project is shared with WSL at `/mnt/c/Users/Rudransh Shinghal/agentcity-minecraft`; it is not a second copy.

## 2. Open Ubuntu as the existing Linux user

From PowerShell:

```powershell
wsl -d Ubuntu -u ansh
```

Then, **inside Ubuntu**:

```bash
cd '/mnt/c/Users/Rudransh Shinghal/agentcity-minecraft'
whoami
python3 --version
tmux -V
```

`whoami` should print `ansh`. For manual Node work in this WSL terminal, use the pinned Linux runtime:

```bash
export PATH="$PWD/.local/tools/node-v26.3.1-linux-x64/bin:$PATH"
node --version
```

This PATH setting lasts for the current terminal. The host launcher already selects that runtime. Some WSL Node imports from the Windows filesystem take minutes; check logs before starting a duplicate worker. Use Windows Node for the documented Windows-side commands.

If Ubuntu is missing, check that you are logged into the original Windows account: WSL registrations belong to Windows users. Do not install another Ubuntu or clone the repository as a shortcut; those would lack the existing private configuration and state.

## 3. Check the host before starting anything

Inside Ubuntu, from the project folder:

```bash
python3 scripts/host_node.py status
tmux -L agentcity-host list-sessions
```

Status prints the current saved **Minecraft public address**, **HTTPS onboarding origin** and owned sessions. Use those addresses rather than older chat links. Status/session presence alone does not prove every service is healthy.

To watch the worker:

```bash
tmux -L agentcity-host attach -t agentcity-worker
```

Detach with **Ctrl+B, release, then D**. Detaching keeps it running. `exit` closes your ordinary WSL shell; avoid Ctrl+C inside an attached service. No tmux sessions does not prove no worker is running, so use the coordinated launcher below rather than starting workers manually.

## 4. Start only if needed, during an idle handover

If hosting needs starting and players/tasks are idle, run from the **Windows PowerShell project folder**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\host_node_windows.ps1
```

This uses the existing launcher and keeps the Windows host awake while its hosting marker is enabled. Leave that helper running. It does not create missing private state or restore a missing Minecraft/database container. If it refuses because a physical operation needs reconciliation, resolve that operation instead of bypassing the check.

Recheck status from PowerShell:

```powershell
wsl -d Ubuntu -u ansh -- python3 scripts/host_node.py status
```

Do not run `wsl --shutdown`, reset Docker, delete `.local`, recreate containers, run a world bootstrap or start a second worker during a live session. Do not pull/reset over existing work without checking `git status`.

## 5. Useful checks and logs

From the **Windows PowerShell project folder**:

```powershell
Get-Content .local/playable-world/worker.log -Tail 40
Get-Content .local/playable-world/agentcity-playable-ce946e82/logs/latest.log -Tail 40
docker inspect agentcity-playable-ce946e82 --format '{{.State.Running}}'
(Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10).models.name
git status --short
```

The last service check reads the existing **Windows Ollama** model list; the personal agent selects **qwen3:4b**, reached by the WSL inference bridge. If it fails, check the existing Windows Ollama app and `agentcity-inference` tmux session. Do not install a second model service in WSL to bypass it.

Minecraft joins through the public address reported by status. Discord `/start` handles account setup; `/profile` reserves a name and `/join` approves the actual game connection. See the [full command guide and handoff](HANDOFF_2026-11-01.md#connect-and-use-it) for player/agent/marketplace usage.

Private credentials remain outside Git. Never share `.local` configuration dumps or raw logs without checking for secrets. Keep Paper **25596**, plugin API **25597**, renderer **8793** and PostgreSQL **55432** private; the existing ingress/tunnels provide player access.

Verified 1 November 2026: Ubuntu WSL 2/user `ansh`, Python 3.12.3, tmux 3.4, Windows Node v26.3.1, Git 2.49.0.windows.1, Docker client/server 27.5.1 and qwen3:4b in the Windows Ollama model list. This is an existing-host access guide, not a fresh-machine installation or restore procedure. For backup, test evidence, remaining work and maintenance limits, use the [current handoff](HANDOFF_2026-11-01.md).
