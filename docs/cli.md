# CLI

CLI도 데스크톱과 같은 데몬, 같은 `agents.json`을 써요. 데몬이 꺼져 있어도 `agent` / `memory` / `routine`의 설정 변경은 파일에 바로 반영돼요. `group`은 데몬을 거치지 않고 `groups.json`에 바로 써요. 켜져 있는 창은 새 그룹을 다음 목록 갱신에서 가져와요. `tell`, `send`, `reset`, `routine run`처럼 살아 있는 세션이 필요한 명령은 데몬을 띄운 뒤에 실행해요.

봇 세션 안에서 `crew tell`을 실행하면 `CREW_AGENT_ID`가 보낸 사람이 돼요. `routine`은 봇 id를 생략하면 그 봇의 루틴을 가리켜요 (`crew routine edit 아침 …`). 루틴을 바꾸면 그 봇의 루틴이 다음 실행 시각과 함께 출력돼요. 에이전트 프로세스가 데몬을 새로 띄우지는 않아요.

```bash
crew                    # 데스크톱
crew app
crew daemon             # 백그라운드 서버만
crew stop

crew agent list
crew agent add review --cli claude --name "리뷰어"
crew agent add impl --cli grok --cwd ~/Projects/app
crew agent add hack --cli codex
crew agent set grok --name "그록봇 테스터"
crew agent set grok --model grok-4 --effort high --shape circle --color "#ff6a00"
crew agent clone grok --name "Grok 복사본"
crew agent remove shell
crew agent add --cli grok --name "리뷰어"
crew agent add --cli agy --name "안티그래비티"
crew agent add --headless --name "내 봇" --cmd my-ai --print

crew group list
crew group add --name "작업"
crew group add --name "리뷰" --bot review --bot impl
crew group memory show --group <그룹 id>
crew group memory append 이 그룹은 develop 브랜치에서 일한다   # 봇 세션 안에선 그 봇의 그룹

crew tell grok 이 파일의 테스트를 보강해줘
crew tell review --from grok 방금 패치 리뷰해줘
crew tell review <<'EOF'
인자가 없으면 메시지를 stdin에서 읽어요
EOF
crew ask --question "어느 쪽을 고를래?" --option A --option B --option C
crew ask --question "어떤 걸 넣을까?" --option 테스트 --option 문서 --multi
crew ask --question "로그인" --input 아이디 --input 비밀번호
crew ask -q "머지할까요?" -o 네 -o 아니요 -q "릴리즈 이름은?" --input 이름

crew routine add grok --name "아침" --schedule "0 8 * * 1-5" --prompt "오늘 할 일 브리핑"
crew routine add grok --name "아침" --schedule "평일 8시에 브리핑" --prompt "오늘 할 일 브리핑"
crew routine list grok
crew routine edit grok 아침 --schedule "0 9 * * 1-5"
crew routine pause grok 아침
crew routine remove grok 아침
crew routine run grok 아침

crew memory show grok
crew memory set grok 사용자는 한국어로 짧게 답하길 좋아한다
crew memory append grok 이 레포는 워크스페이스 루트가 crew 다

crew share show
crew share append 배포는 develop에서 확인한다
crew share set 팀 규칙만 남긴다

crew remote list                              # 붙어 있는 라우터와 그 위의 원격 봇
crew tell lab/acc_k3j9x0abcd12 이 API 리뷰 부탁해   # 다른 PC의 봇
crew team memory show
crew team memory append 배포는 금요일에 하지 않는다
crew team memory set --remote lab 팀 규칙만 남긴다

crew messages grok
crew reset grok
crew reset grok --drop-routines
```

## `crew agent add`

`--cli grok|claude|codex|agy|gemini|copilot|opencode` 또는 `--cmd …`가 필요해요. `--cmd`를 주면 `--cli`는 무시돼요. `--cmd`는 꼭 맨 끝에 두세요. 그 뒤에 오는 건 `--name` 같은 플래그까지 모두 명령의 인자로 들어가요. 모르는 명령을 대화로 쓰려면 `--headless`를 같이 주세요. 메시지는 그 명령의 마지막 인자로 붙어요. `--headless`가 없으면 모르는 명령은 터미널로 남아요. id를 생략하고 `--name`을 주면 id를 만들어서 `ok <id>`로 출력해요. id를 직접 주면 그 id를 그대로 써요. 작업 폴더를 생략하면 `/tmp/crew-demo/<id>`가 돼요.

## `crew group`

`crew group add --name`은 사이드바 그룹을 만들어요. `--bot <id>`를 반복하면 그 봇을 다른 그룹에서 빼 새 그룹에 넣어요. 없는 봇 id는 거절해요. `crew group list`는 `id`, 이름, 봇 id를 탭으로 나눠 출력해요. `crew group memory show|set|append`는 `--group <id>`의 노트를 다뤄요. 생략하면 `CREW_AGENT_ID` 봇이 있는 그룹이에요.

## `crew remote` · `crew team memory`

원격 봇은 0.6.0부터 쓸 수 있어요. 라우터에 붙는 건 앱의 **+ → 원격 봇 추가**에서 해요. `crew remote list`는 라우터마다 별칭, 주소, 내 이름, 대표 봇, 연결 상태와 팀원들의 원격 봇 id(`<별칭>/<계정 id>`)를 출력해요. 그 id로 `crew tell`하면 그 봇이 자기 PC에서 일하고, 답은 보낸 봇에게 돌아와요.

`crew team memory show|append|set`은 라우터의 팀 공용 메모를 다뤄요. `--remote <별칭>`을 생략하면 대표 봇 세션 안에선 그 봇의 라우터, 아니면 라우터가 하나일 때 그 라우터예요. `set`은 그 사이 다른 사람이 고쳤으면 거절돼요. 데몬과 라우터 연결이 필요해요.

## `crew ask`

`--question`(`-q`)을 반복하면 한 카드에 여러 질문을 묶어요. 각 `--option`(`-o`), `--input`, `--hint`, `--multi`는 바로 앞 `--question`에 붙어요. 사용자가 비워 둔 질문은 `(no answer)`로 돌아와요.
