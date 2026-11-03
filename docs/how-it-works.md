# Crew가 동작하는 방식

README에서 뺀 개념 설명이에요. 쓰는 데는 몰라도 되지만, 봇이 왜 그렇게 움직이는지 궁금할 때 읽으면 돼요.

## 봇

봇 하나는 `agents.json`의 한 항목이에요. 이름, 작업 폴더, 모델, 아바타를 갖고 있고, 메시지를 받으면 그 봇에 지정된 `cmd`를 실행해요. 새로 만들면 그 봇이 먼저 어떤 일이나 역할을 맡기면 될지 물어요.

기본 명령은 각 CLI의 승인 프롬프트를 건너뛰도록 되어 있어요. 데스크톱 채팅이 TUI 권한 화면에서 멈추지 않게 하기 위해서인데, 이 플래그가 어디까지 허용하는지는 알고 쓰는 편이 좋아요.

| CLI | 기본 `cmd` |
| --- | --- |
| Grok | `grok --always-approve` |
| Claude | `claude --dangerously-skip-permissions` |
| Codex | `codex --yolo` |
| Antigravity | `agy --dangerously-skip-permissions` |
| Gemini | `gemini --approval-mode yolo` |
| Copilot | `copilot --allow-all --no-ask-user` |
| OpenCode | `opencode run --auto` |

Grok / Claude / Codex는 턴 단위 헤드리스로 실행돼요. `-p` / `exec`의 스트리밍 JSON만 읽기 때문에 배너나 스피너, 단축키 안내가 말풍선에 섞이지 않아요. CLI 세션 id는 봇별로 보관하니까 대화를 이어서 할 수 있고, 대화를 지우면 새 세션이 열려요.

Antigravity / Gemini / Copilot / OpenCode도 턴 단위로 실행하지만 세션 id는 두지 않아요. 대신 매 턴 지금까지의 대화를 프롬프트에 같이 보내요.

목록에 없는 명령도 봇으로 쓸 수 있어요. `--headless`로 만들면 메시지마다 그 명령을 실행하고, 메시지는 마지막 인자로 붙어요. `--headless`가 없으면 `cat` 같은 스텁처럼 긴 PTY 세션, 즉 터미널로 남아요. 테스트나 간단한 에코 봇에 쓰면 돼요.

핵심은 데몬이에요. 데스크톱 앱과 `crew` CLI가 Unix 소켓으로 JSON 요청을 보내면, 데몬이 에이전트 프로세스를 실행해요.

## 핸드오프

세션마다 `CREW_AGENT_ID`와 확장된 `PATH`가 들어가요. 시스템 프롬프트는 대략 이렇게 알려 줘요.

> 사용자가 `@id`를 쓰면 그건 **너에게** 다른 봇을 가리키는 것이다. 이 세션에 남아라. 필요하면 직접 `crew tell <id> <text>`를 실행해라.
> 이름을 바꿔 달라면 `crew agent set --name "새 이름"`을 실행해라. 봇을 만들라면 `crew agent add`를, 사이드바 그룹을 만들라면 `crew group add`를 실행해라. 반복 일을 맡기면 그 말을 cron으로 바꿔 `crew routine add`로 루틴을 만들고, 고치거나 지우라면 `crew routine edit` / `remove`를 실행해라.
> 사람에게 고르라고 물으려면 `crew ask --question "..." --option A --option B`를 실행해라. 여럿 고를 수 있으면 `--multi`, 값을 적으라고 하려면 `--input 아이디`를 보태라. 정할 게 여러 개면 답장에 늘어놓지 말고 `--question`을 반복해 한 번에 물어라. 다른 봇에게 묻지 마라.
> 서로 의존하지 않는 일 여러 개는 CLI 자체 서브에이전트(Claude Agent, grok spawn_subagent, agy invoke_subagent)에게 나눠 병렬로 돌리고, 답은 다 모인 뒤 한 번에 해라. 서브에이전트는 팀원이 아니다.
> 일을 받으면 도구를 쓰기 전에 어떻게 할지 한두 문장으로 말하고, 옆자리 동료처럼 지금 하는 일을 한 줄씩 알려 준 뒤 결과로 끝내라. 작은 일은 답만 해라.
> 나중 대화에 필요한 걸 알게 되면 `crew memory append`로 적어라. 고치거나 잊으라면 `crew memory show`로 보고 `crew memory set`으로 다시 써라. 비밀은 적지 마라.
> 팀 전체 메모와 지금 봇 목록은 공유 메모리에 있다. `crew share show`로 보고, 팀 메모는 `crew share append`로 더하고 `crew share set`으로 노트만 다시 쓴다. 봇 목록은 Crew가 매번 다시 쓴다. 그룹에 있으면 그 그룹의 메모는 `crew group memory show|append|set`으로 다룬다.

멘션은 `@id`로 저장되고 화면에는 봇 이름으로 보여요. 입력창에 이름을 적어도 보낼 때 id로 바뀌고, 봇도 답에 동료를 `@id`로 적어요. 사용자가 이름을 여러 개 적으면 지금 봇이 답을 끝낸 뒤에, 적힌 순서대로 한 명씩 답해요. 봇이 한 턴에 여러 봇에게 `crew tell`을 보내면 그 일들은 함께 시작해요. 봇 사이의 릴레이는 사용자 메시지 하나당 최대 4홉이에요.

## 메모리

### 봇 메모리

대화 기록은 지우면 아카이브로 옮겨가지만, `$CREW_HOME/memory/<id>.md`는 그대로 남아요. 메모리 탭에서 직접 적을 수도 있고, 봇이 대화하다 오래 남길 만한 걸 알게 되면 스스로 `crew memory append`로 적어요. 고치거나 잊을 땐 `crew memory set`으로 통째로 다시 쓰고, 비밀번호나 토큰은 적지 않아요.

새 세션을 열 때 Grok은 `--rules`로, Claude는 `--append-system-prompt`로, Codex는 `-c developer_instructions=`로 그 봇의 메모리를 넣어 줘요. 이런 플래그가 없는 다른 CLI는 매 턴 프롬프트 앞에 넣어요. Claude와 Codex는 이어지는 턴에 처음 시스템 프롬프트를 그대로 쓰고, Grok은 시스템 프롬프트가 바뀌면 프롬프트 캐시를 잃어요. 그래서 세션 도중에 그 봇의 메모리가 바뀌면 시스템 프롬프트는 그대로 두고, 다음 턴 앞에 `[crew system]` 메모로 새 내용을 한 번 알려 줘요. 봇을 복제하면 그 메모리도 함께 복사되고, 봇을 삭제하면 그 파일도 같이 지워져요.

### 공유 메모리

`$CREW_HOME/shared.md` 하나예요. 모든 봇이 같은 노트를 봐요. 메모리 탭에서는 읽기만 하고, 고치는 건 봇이 `crew share`로 해요. 봇 목록은 이 파일에 적히지 않아요. 매 턴 프롬프트의 `Shared memory` 노트가 지금 명단과 공유 노트를 같이 넣어요. 대화가 압축돼도 다음 턴에 다시 붙어요. `crew share set`은 노트만 바꾸고, 명단은 Crew가 그 턴의 봇 목록으로 다시 만들어요.

### 그룹 메모리

사이드바 그룹 하나의 노트예요(`$CREW_HOME/group-memory/<그룹 id>.md`). 그 그룹에 있는 봇만 `Shared memory` 노트의 `# Group memory` 단락으로 함께 읽어요. 그룹 설정에서 직접 고치거나, 봇이 `crew group memory append` / `set`으로 고쳐요. 그룹을 지울 때만 같이 지워져요.

## 메시지 전달과 중지

- 설정의 메시지 전달은 기본이 인터럽트예요. 작업 중일 때 보낸 메시지가 지금 턴을 멈추고 그 메시지부터 시작해요. 대기열로 바꾸면 순서대로 기다려요. 대기열은 봇당 최대 32개예요.
- 대기열 모드에서 바로전송을 누르면, 봇이 작업 중이어도 지금 턴은 멈추지 않고 그 줄이 턴 다음에 혼자 나가요.
- CLI가 한 줄도 쓰기 전에 멈추면 그 턴에 묶인 메시지는 대기열 앞으로 돌아가고, 다음 메시지나 바로전송을 기다려요.
- 시작 후 첫 출력이 없을 때도(grok 15초, claude·codex 30초) 같이 돌아가고, 채팅에 `CLI가 응답하지 않습니다`가 남아요. 이어가던 세션이 그래서 멈추면 그 세션을 버리고, `CLI가 이전 세션에서 응답하지 않아 새 세션으로 다시 보냅니다`라고 남긴 뒤 새 세션에서 한 번 더 보내요. 새 세션도 답이 없으면 `CLI가 응답하지 않습니다`와 함께 대기열에 둬요.

## 그룹 작업 폴더

그룹에 작업 폴더를 정하면 그 그룹 안 봇의 작업 폴더가 그 폴더로 바뀌어요. 그 그룹으로 옮긴 봇과 그 그룹에서 새로 만든 봇도 거기서 일해요. 폴더는 선택이에요.

## 루틴

일정은 5필드 cron이에요. 실패한 실행도 그 분(minute)의 슬롯을 쓴 것으로 쳐요. 같은 분에 다시 실행되지 않도록요.

## 사용량

사용량 버튼은 로컬에서 읽을 수 있는 값만 써요. API 키를 등록해야 하는 AI는 넣지 않아요.

| CLI | 읽는 곳 |
| --- | --- |
| Claude | Crew가 돌린 Claude 턴이 알려 준 한도 |
| Grok | `~/.grok/logs` |
| Codex | `~/.codex/sessions` |
| Antigravity | `agy -p /usage` (5분 캐시) |

마지막으로 읽은 값은 `$CREW_HOME/plan-usage-*.json`에 남겨요.

## 데이터 위치

기본 경로는 `~/Library/Application Support/crew`이고, `CREW_HOME`으로 바꿀 수 있어요.

| 경로 | 내용 |
| --- | --- |
| `agents.json` | 봇·루틴 |
| `groups.json` | 사이드바 그룹과 그룹 작업 폴더 |
| `group-memory/<그룹 id>.md` | 그룹 메모리 |
| `locale` | `ko` 또는 `en` (알림·CLI 라벨) |
| `roster.md` | 저장된 봇 명단 사본 |
| `shared.md` | 공유 메모리 노트. 봇 목록은 매 턴 이 메모와 함께 최신으로 전달 |
| `memory/<id>.md` | 대화를 지워도 남는 그 봇의 기억 |
| `skills/<이름>.md` | `/이름` 스킬 |
| `transcripts/<id>.jsonl` | 1:1 대화 |
| `cli-sessions/<id>` | Grok/Claude/Codex 세션 id |
| `cli-memory/<id>` | 그 세션이 아는 메모리 (바뀌면 알려 주려고) |
| `archive/` | 지운 대화 |
| `uploads/` | 첨부 파일 |
| `crew.sock` / `crew.pid` | 데몬 |
| `crew.log` | 데몬 로그 |
| `plan-usage-*.json` | 사용량 버튼이 마지막으로 읽은 값 |
