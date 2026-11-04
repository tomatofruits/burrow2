# Deployment helpers

`update.sh` fetches the configured branch, fast-forwards only, validates changed
JavaScript, and restarts the server only when a loaded server file changed. It
runs as root, but uses `BURROW_USER` for Git operations.

## systemd

The existing `burrow-update.service` and `burrow-update.timer` check for an
update every two minutes.

## OpenRC

The OpenRC service keeps a small foreground loop alive and runs the same
updater every two minutes. It does not require cron.

```sh
install -m 755 deploy/burrow-update.openrc /etc/init.d/burrow-update
install -m 644 deploy/burrow-update.conf /etc/conf.d/burrow-update
rc-update add burrow-update default
rc-service burrow-update start
```

Uncomment and change values in `/etc/conf.d/burrow-update` when the server is
not installed at `/home/aj/ajc-private-server`, runs as a different user, or
uses a differently named OpenRC service. `BURROW_UPDATE_INTERVAL` is a positive
number of seconds and defaults to `120`.

`update.sh` selects OpenRC automatically when run by OpenRC. Set
`BURROW_INIT=openrc` when running it manually or from another supervisor. Set
`BURROW_INIT=systemd` to force systemd.

## GitHub and the VPS

The server's mutable data is deliberately outside Git: `data/` (accounts,
settings, rules, backups, the device key) and `cache/` (the official CDN
mirror) are in `.gitignore`, as are `.env`, logs, `node_modules/`, `ffdec-out/`
and the local decompiler. A pull therefore never replaces any of it.

### First push to your own GitHub repository

Create an empty GitHub repository (no README, no `.gitignore`), then from this
checkout (the original repository is already kept as `upstream`):

```sh
git remote add origin git@github.com:YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

If you are doing this from a copy whose remote is still the original
repository, keep it and add yours instead:

```sh
git remote rename origin upstream
git remote add origin git@github.com:YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

`git add -A` respects `.gitignore`, so `data/`, `cache/`, `.env` and local build
output are not uploaded. Review `git status` before committing; it should not
list anything under `data/` or `cache/`.

### First pull on a VPS that already runs the server

Back up the database once, then point the existing checkout at the new
repository. The working tree may already have `.git`, `data/` and `cache/`.

```sh
cd /home/aj/ajc-private-server

# a copy of the live data, outside the checkout
cp -a data "/home/aj/data-backup-$(date +%F)"
cp -a cache "/home/aj/cache-backup-$(date +%F)"

git remote set-url origin git@github.com:YOUR-NAME/YOUR-REPO.git
git fetch origin
git merge --ff-only origin/main
```

If the VPS checkout still has the old `origin`, use `git remote rename origin
upstream` first, exactly as above.

`data/`, `cache/`, `.env`, local backups and logs are ignored, so the merge
leaves them untouched. Do **not** run `git clean -fdx` or `git reset --hard`
on the VPS: those delete ignored data. The updater in `update.sh` already uses
only `git merge --ff-only`.

### Keeping the VPS current

The existing systemd/OpenRC updater runs the same safe fast-forward and only
restarts the service when a file the server loads at startup changed. Keep
site-specific values in the service environment rather than editing tracked
files such as `config.js`; a modified tracked file is exactly what makes a
fast-forward refuse to run.

`swf/ajclient.swf` is the built client and is kept in Git, so a VPS that pulls
it does not need Java or the decompiler. If you rebuild it locally with
`tools/build-client.sh`, commit the new file with the source changes.
