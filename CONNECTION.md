# 에이전트 연결

core 설치는 README의 공식 설치 절차를 따른다. `brain setup connect <harness>`는 하네스의 수집 hook을 연결하며, SessionStart hook은 CLI 사용법을 주입하지 않는다. 에이전트가 기능을 발견하려면 배포 스킬도 연결해야 한다.

## Claude Code

공식 second-brain 및 second-brain-garmin 플러그인을 설치·갱신하면 각 플러그인에서 스킬을 발견한다. 호출 예시는 `/second-brain:brain-recall`, `/second-brain:brain-install`, `/second-brain-garmin:brain-garmin-operations`다. core 14개는 `brain-*`, Garmin 2개는 `brain-garmin-*` 이름을 사용한다.

## Codex와 plugin namespace가 없는 하네스

공식 설치본을 최신 릴리스로 갱신한 뒤 배포 스킬 전부를 `~/.agents/skills/brain-*`에 symlink한다. 아래의 원천은 공식 설치기가 관리하는 `${SECOND_BRAIN_HOME:-$HOME/.second_brain}/app`이다. 개발 워크트리나 임의 다운로드를 연결하지 않는다. 아직 설치본에 새 스킬 이름이 없으면 릴리스 갱신 전이므로 중단한다. 스킬만 연결하는 절차이며 core 설치·인증·메신저 발신을 대신하지 않는다.

다음 Bash 블록은 이름과 원천을 모두 검사하고 대상에 동명 항목이 하나라도 있으면 **링크 생성 전에 중단**한다. 기존 파일·디렉터리·정상/끊어진 symlink를 덮어쓰거나 자동 삭제하지 않는다. 이미 연결했다면 중단이 정상이며, 기존 항목의 소유권을 확인한 뒤 필요한 정리는 사용자가 따로 결정한다. 이전 이름으로 연결한 스킬도 임의로 제거하지 말고 원천·소유권을 확인해 별도로 정리한다.

```bash
(
  set -eu
  brain_app="${SECOND_BRAIN_HOME:-$HOME/.second_brain}/app"
  brain_skills_dir="$HOME/.agents/skills"
  brain_core_names=(channels config ext files guide install login messages recall schedules sessions setup sources status)
  brain_garmin_names=(install operations)
  brain_skill_sources=()

  for brain_area in "${brain_core_names[@]}"; do
    brain_skill_sources+=("$brain_app/plugin/skills/brain-$brain_area")
  done
  for brain_area in "${brain_garmin_names[@]}"; do
    brain_skill_sources+=("$brain_app/plugins/garmin/skills/brain-garmin-$brain_area")
  done

  # 16개 전체를 먼저 검사한다. 동명 항목이 있으면 아무 링크도 만들지 않는다.
  for brain_source in "${brain_skill_sources[@]}"; do
    brain_name="${brain_source##*/}"
    if [ ! -f "$brain_source/SKILL.md" ]; then
      printf '공식 설치본에 스킬이 없습니다: %s\n' "$brain_name" >&2
      exit 1
    fi
    if ! grep -q -x -- "name: $brain_name" "$brain_source/SKILL.md"; then
      printf '스킬 폴더명과 name이 다릅니다: %s\n' "$brain_name" >&2
      exit 1
    fi
    if [ -e "$brain_skills_dir/$brain_name" ] || [ -L "$brain_skills_dir/$brain_name" ]; then
      printf '동명 항목이 있어 중단합니다: %s\n' "$brain_name" >&2
      exit 1
    fi
  done

  mkdir -p "$brain_skills_dir"
  for brain_source in "${brain_skill_sources[@]}"; do
    brain_name="${brain_source##*/}"
    ln -s "$brain_source" "$brain_skills_dir/$brain_name"
  done
)
```

새 Codex 세션에서 `brain-recall` 등 배포 스킬 이름이 발견되는지 확인한다. 스킬이 보이지 않으면 symlink와 공식 설치본의 `SKILL.md`를 확인하며 원본 스킬을 사용자 폴더에 복사해 이중 관리하지 않는다. 이후 공식 설치본 갱신은 같은 경로의 링크에 반영된다.

Garmin package와 `extensions/garmin/skills/`의 `garmin-daily-analysis`, `garmin-period-review`, `garmin-body-intake`는 감독 runtime이 지정한 입력·출력 계약으로 실행하는 내부 분석 스킬이다. 배포 CLI를 발견하는 스킬이 아니므로 이름을 바꾸거나 위 사용자 스킬 폴더에 연결하지 않는다.
