# shellcheck shell=sh
# Every shell tab is a login shell, and /etc/profile builds PATH from scratch.
# This puts the add-on's own environment back, from the one file that declares
# it. The core ships its own profile snippet for the tools it installs; this one
# owns what this add-on installs.
[ -r /usr/local/lib/codex-env.sh ] && . /usr/local/lib/codex-env.sh
