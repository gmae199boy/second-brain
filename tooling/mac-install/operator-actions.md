# 운영자 확인: Claude 스킬 발견과 설치

자동 승인 심사는 Claude 세션 실행을 거부했다. 원문: “실제 Claude 세션과 플러그인을 외부 서비스에 로드하면 저장소의 플러그인 내용·메타데이터가 전송될 수 있는데, 해당 민감 데이터와 목적지를 구체적으로 승인한 근거가 없습니다.” 이 명령은 프롬프트와 후보 플러그인의 스킬 내용 및 메타데이터를 Claude 서비스로 전송할 수 있다. 운영자는 해당 전송을 승인할 수 있을 때 직접 실행한다. 기존 CLI의 정상 인증이 필요하며 자격 증명 내용을 복사하지 않는다. 세션 기록은 민감할 수 있으므로 검토 후 공개한다.

조사 시 운영 marketplace 등록은 로컬 directory였지만 설치 metadata는 0.1.10 캐시를 가리켰고 그 캐시에는 install 스킬 파일이 없었다. 이는 아래 후보 플러그인의 새 세션 발견 결과와 별개다. 원격 marketplace 갱신은 커밋을 원격에 push한 뒤 운영자가 수행한다.

Node 24.16 이상, pnpm, Docker, 인증된 Claude CLI가 필요하다. 저장소 루트에서 `node tooling/mac-install/run.mjs prepare`를 실행하고 출력의 root 값을 아래 `검증-디렉터리`에 넣는다. 이후 명령의 파일은 격리 디렉터리에만 쓴다.

```sh
export BRAIN_VERIFY_ROOT='<검증-디렉터리>'
node tooling/mac-install/run.mjs setup "$BRAIN_VERIFY_ROOT"
unset BRAIN_DATABASE_URL
export SECOND_BRAIN_HOME="$BRAIN_VERIFY_ROOT/brain-home"
export CLAUDE_CONFIG_DIR="$BRAIN_VERIFY_ROOT/claude-config"
export SECOND_BRAIN_TEST_EXTENSIONS="$BRAIN_VERIFY_ROOT/fixtures"
export SECOND_BRAIN_REPO="$(node -e 'console.log(require("node:url").pathToFileURL(process.cwd()).href)')"
export CLAUDE_PLUGIN_ROOT="$BRAIN_VERIFY_ROOT/plugin"
export SECOND_BRAIN_LAUNCHCTL="$(pwd)/apps/cli/test/fixtures/fake-launchctl.sh"
export SECOND_BRAIN_LAUNCH_AGENTS="$BRAIN_VERIFY_ROOT/launch-agents"
export FAKE_LAUNCHCTL_DIR="$BRAIN_VERIFY_ROOT/launchctl"
export PATH="$SECOND_BRAIN_HOME/bin:$PATH"
node -e 'const fs=require("fs"),p=process.env.BRAIN_VERIFY_ROOT;fs.writeFileSync(p+"/plugin/app-ref",JSON.parse(fs.readFileSync(p+"/ownership.json")).candidate+"\n")'
sh "$CLAUDE_PLUGIN_ROOT/bin/session-start.sh"
```

`installed.json`의 commit이 영수증의 candidate와 같은지 확인한다. 격리 데몬을 시작하고 PID를 기록한다. 시험 로그인은 실제 서비스 인증이 아니다.

```sh
"$SECOND_BRAIN_HOME/bin/brain" daemon run > "$BRAIN_VERIFY_ROOT/evidence/daemon-operator.log" 2>&1 &
printf '%s\n' "$!" > "$BRAIN_VERIFY_ROOT/daemon.pid"
```

`$SECOND_BRAIN_HOME/run/supervisor-ready.json`이 생성된 뒤 새 세션을 시작한다. 아래 두 호출은 같은 세션이며 첫 응답에서 얻은 `session_id`를 두 번째 명령에 넣는다. 첫 응답에서 install 스킬 호출과 실제 `brain guide schema ext`, `brain ext status testext`, `brain ext install testext` 호출, 인증 미완료 보고를 확인한다. 호출 증거가 없거나 기대 상태가 아니면 중단하고 실패를 기록한다. `--output-format stream-json --verbose`의 결과 파일에는 대화가 들어가므로 비밀 제거 전 공개하지 않는다.

```sh
claude -p '/second-brain:install 스킬로 testext를 설치해 주세요. 시험 로그인 완료 전에는 멈추고 상태를 보고하세요.' --plugin-dir "$CLAUDE_PLUGIN_ROOT" --settings '{"disableAllHooks":true}' --allowedTools 'Skill,Bash' --output-format stream-json --verbose > "$BRAIN_VERIFY_ROOT/evidence/claude-first.json"
touch "$SECOND_BRAIN_HOME/extensions/testext/tokenstore/ready"
claude -p --resume '<첫-응답-session_id>' '시험 로그인 완료를 확인했습니다. 같은 스킬 절차로 설치를 재개하고 최종 상태를 조회하세요.' --plugin-dir "$CLAUDE_PLUGIN_ROOT" --settings '{"disableAllHooks":true}' --allowedTools 'Skill,Bash' --output-format stream-json --verbose > "$BRAIN_VERIFY_ROOT/evidence/claude-resume.json"
brain ext status testext --json > "$BRAIN_VERIFY_ROOT/evidence/operator-status.json"
```

세션의 스킬 호출과 실제 CLI 호출을 원본에서 확인하고 마지막 상태의 여덟 단계, 연결, 예약을 대조한다. 정리 전에 원본 세션을 포함한 evidence와 영수증만 별도 보호 디렉터리에 복사하고 출력된 위치를 기록한다. 앱, DB 및 Claude 인증 디렉터리는 복사하지 않는다.

```sh
BRAIN_EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brain-evidence.XXXXXX")"
chmod 700 "$BRAIN_EVIDENCE_DIR"
cp -R "$BRAIN_VERIFY_ROOT/evidence" "$BRAIN_EVIDENCE_DIR/"
cp "$BRAIN_VERIFY_ROOT/ownership.json" "$BRAIN_EVIDENCE_DIR/"
printf '보존 위치: %s\n' "$BRAIN_EVIDENCE_DIR"
```

 ready marker는 fixture 입력일 뿐 사용자 인증이 아니다. 정리는 먼저 기록된 foreground PID가 이 실행에서 시작한 데몬인지 확인한 다음 종료하고, 종료가 확인된 경우에만 PID 파일을 지운다. 그 후 소유권 검사를 수행하는 정리 명령을 실행한다. 실패 시 영수증과 증거를 보존한다.

```sh
kill -TERM "$(cat "$BRAIN_VERIFY_ROOT/daemon.pid")"
# 해당 PID의 종료를 확인한 뒤에만 실행한다.
rm "$BRAIN_VERIFY_ROOT/daemon.pid"
node tooling/mac-install/run.mjs cleanup "$BRAIN_VERIFY_ROOT"
```
