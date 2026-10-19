# Shared by pre-commit and commit-msg. Matches this machine's home folder as an
# absolute path, and the dash-joined form Claude Code uses for project folders.
# The user name comes from the OS at run time, so no name is written in the repo.
user=$(id -un)
home_path_pattern="(/Users/|/home/)${user}([^A-Za-z0-9._-]|$)|-Users-${user}(-|$)"
home_path_hint='홈 폴더 절대 경로가 있습니다. ~/… 나 <repo>/… 로 바꾸세요(AGENTS.md Policy).'
