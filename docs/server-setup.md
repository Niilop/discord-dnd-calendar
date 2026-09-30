# One-time server setup (Hetzner Cloud)

Target: a small Hetzner Cloud VM (a CX22 / 2 vCPU / 4 GB is more than enough) running Ubuntu 24.04.

## 1. Create the VM

- Add your personal SSH key when creating it.
- Attach a **Hetzner Cloud Firewall** that allows inbound **TCP 22 only** (optionally restricted to your IPs). The bot only makes outbound connections, and Postgres is never exposed.
- Consider enabling Hetzner's server backups/snapshots as an *extra* layer. They don't replace the off-server database dumps below.

## 2. Base system

```bash
ssh root@<ip>
apt update && apt -y upgrade
apt -y install ca-certificates curl unattended-upgrades rclone
dpkg-reconfigure -plow unattended-upgrades

# Docker Engine + Compose plugin from Docker's repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Harden SSH in `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`. Then run `systemctl restart ssh`.

## 3. Deploy user and directories

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy          # note: docker group ≈ root on this host; the VM is single-purpose
install -d -o deploy -g deploy -m 750 /opt/dnd-calendar
install -d -o deploy -g deploy -m 700 /var/backups/dnd-calendar
```

Generate a **dedicated** key pair for GitHub Actions on your machine, not on the server:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f dnd-deploy-key
```

Put `dnd-deploy-key.pub` into `/home/deploy/.ssh/authorized_keys` (mode 600, owned by deploy). Store the private key `dnd-deploy-key` as the `DEPLOY_SSH_KEY` secret, then delete the local copy.

Get the host key for `DEPLOY_SSH_KNOWN_HOSTS`, and compare its fingerprint with the one on the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`):

```bash
ssh-keyscan -t ed25519 <ip>
```

## 4. Runtime secrets

```bash
sudo -u deploy -i
cd /opt/dnd-calendar
# after the first deploy has uploaded .env.example (or copy it by hand now):
cp .env.example .env && chmod 600 .env
nano .env    # DISCORD_TOKEN, DISCORD_APPLICATION_ID, POSTGRES_PASSWORD=$(openssl rand -hex 24), BACKUP_* …
```

Leave `DISCORD_DEV_GUILD_ID` empty in production, so commands register globally.

The first deploy fails fast if `.env` is missing. Create it before pushing to `main`, or re-run the workflow afterwards.

## 5. Off-server backups (rclone)

Example with a Hetzner Storage Box. Enable SSH support on the box, and note that it listens on port 23:

```bash
sudo -u deploy -i
rclone config
#  n) new remote "storagebox": type sftp, host uXXXX.your-storagebox.de, user uXXXX, port 23, password or key
#  n) new remote "storagebox-crypt": type crypt, remote "storagebox:dnd-calendar", set a strong password
#     (store the crypt passwords in your password manager — without them the backups are unreadable)
rclone mkdir storagebox:dnd-calendar
```

Then in `.env`:

```
BACKUP_RCLONE_REMOTE=storagebox-crypt:
BACKUP_RCLONE_RETENTION_DAYS=60
```

Test it: `/opt/dnd-calendar/scripts/backup.sh manual && rclone ls storagebox-crypt:`

## 6. Daily backup timer

After the first deploy (which uploads `deploy/systemd/`):

```bash
cp /opt/dnd-calendar/deploy/systemd/dnd-calendar-backup.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dnd-calendar-backup.timer
systemctl list-timers dnd-calendar-backup.timer
journalctl -u dnd-calendar-backup.service      # logs of past runs
```

## 7. GitHub

- Repository → Settings → Environments → **production**: add the secrets `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` and `DEPLOY_SSH_KNOWN_HOSTS`. Optionally restrict deployments to `main` and require a reviewer.
- If the repository is private, the GHCR package stays private too. The deploy logs in on the VM with the job's own token, so no extra setup is needed.
- Push to `main`. After the workflow finishes: `scripts/compose.sh ps` should show `bot` as `healthy`.
