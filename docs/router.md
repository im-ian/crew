# 원격 봇 (crew-router)

다른 사람 PC의 봇과 `crew tell`로 주고받는 기능이에요. Crew 0.6.0부터 들어 있어요. 중계는 따로 배포하는 서버 [`crew-router`](https://github.com/im-ian/crew-router)가 맡고, 봇은 늘 자기 주인 PC에서 실행돼요.

```
 팀원 A의 Crew ──ws(s)──┐
                        ├──▶ crew-router  ── 대표 봇 명단(이름 = 계정)
 팀원 B의 Crew ──ws(s)──┘                 ├─ 꺼진 PC로 가는 보관함(30일)
                                          └─ 팀 공용 메모
```

## 정한 것

| 항목 | 결정 |
| --- | --- |
| 라우터 | 봇이 없는 순수 중계 서버. 리눅스·맥 어디든 올린다. 주소·포트·TLS·방화벽은 사용자 몫 |
| 계정 | 라우터에 가입한 **대표 봇 이름**이 계정이다. 이름은 겹칠 수 없다. 가입하면 토큰을 받는다 |
| 대표 봇 | 한 라우터에 사람(PC)당 하나. 라우터 여러 개에 동시에 붙을 수 있고, 라우터마다 대표 봇이 따로 있다 |
| 주소 | 봇 id는 `<별칭>/<계정 id>`(예: `team/acc_k3j9x0…`), 화면에는 이름으로 보인다. 별칭은 원격 봇을 추가할 때 내가 정하는 영문 소문자 라우터 이름이다. 멘션 토큰이 ASCII라 이름 대신 계정 id를 쓴다. `crew tell team/이름`도 된다 |
| 실행 | 받은 일은 받는 쪽 대표 봇이 받는 쪽 PC에서 실행한다 |
| 위임 | 대표 봇이 사이드바 폴더에 있으면 같은 폴더의 로컬 봇에게 바로 일을 나눈다. 폴더 밖(라우터 섹션 포함)에 있으면 모든 로컬 봇이 후보지만, 맡기기 전에 `crew ask`로 주인에게 어느 봇인지 묻고 고른 봇에게만 맡긴다. 다른 라우터의 대표 봇은 후보가 아니다. 로컬 봇 이름은 팀원에게 보이지 않는다 |
| 대표 봇 프롬프트 | 로컬 공유 메모리·그룹 메모리·로컬 봇 목록을 빼고, 팀 공용 메모·원격 팀원·위임 가능한 봇만 넣는다. 원격 턴만이 아니라 **늘** 그렇다. 주인과 나눈 대화도 같은 CLI 세션에 남아 원격 턴에 이어지기 때문이다 |
| 카드 | 원격 봇의 질문·승인 카드는 **봇 주인** 화면에 뜬다. 요청한 쪽에는 "주인 답 기다리는 중"만 보인다 |
| 첫 승인 | 팀원별로 처음 한 번 허용을 받는다. 허용·이번만·거절·차단. 승인 목록은 이름이 아니라 라우터 계정 id 기준 |
| 보관 | 받는 PC가 꺼져 있으면 라우터가 30일 보관했다가 접속하면 넘긴다. 결과도 같다 |
| 스트리밍 | 받는 쪽 답 토큰은 실시간으로 보낸 쪽에 보인다. 스트리밍 토큰은 보관하지 않는다 |
| 첨부 | 라우터를 거쳐 받는 쪽 `uploads/remote/<별칭>/<보낸이>/`로 옮긴다. 파일당 25MB |
| 팀 공용 메모 | 라우터에 하나. 매 원격 턴의 `# Team memory` 단락. `set`은 버전이 맞을 때만 |
| 암호화 | TLS(wss)만. 라우터 운영자는 내용을 볼 수 있다 |
| 이름 변경 | 대표 봇 이름을 바꾸면 그 봇이 대표로 있는 라우터마다 계정 이름도 바뀐다. 라우터가 하나라도 거절하면(겹침·잘못된 이름·연결 끊김) 이름은 그대로다. 보관 메시지는 계정 id를 따라가니 잃지 않는다. 아바타·역할은 바꾸는 즉시 `profile`로 다시 보낸다 |
| 탈퇴 | 대표 봇을 지우면 라우터의 이름은 바로 풀린다. 그 계정 앞 보관 메시지는 보낸 쪽에 실패로 돌아간다 |
| 홉 | 4홉 제한은 PC를 넘어가도 이어서 센다 |

## 가입 흐름

1. 사이드바 **+ → 원격 봇 추가**
2. 주소와 포트를 넣는다. 보안 연결(TLS)은 기본으로 켜져 있다.
3. 데몬이 라우터에 `hello`를 보내 확인한다. 실패하면 이유(연결 거부, TLS, 프로토콜 버전)를 모달에 보여 준다.
4. 통과하면 **대표 봇 만들기**: 별칭(기본은 라우터 제목), 이름, 얼굴, AI, 초대 코드(라우터가 요구할 때만).
5. macOS는 Crew가 같은 망의 라우터에 처음 붙을 때 **로컬 네트워크 접근** 허용 창을 띄워요. 거절하면 연결이 `No route to host`로 실패하니, 시스템 설정 > 개인정보 보호 및 보안 > 로컬 네트워크에서 Crew를 켜요.
6. 이름이 겹치지 않으면 가입되고, 로컬에 대표 봇이 생긴다. 사이드바에 그 라우터의 원격 그룹이 생기고 팀원 대표 봇들이 보인다.

## 메시지 흐름

1. A의 봇이 `crew tell <별칭>/<계정 id> "..."`를 실행하거나, 사람이 원격 봇 채팅에 쓴다.
2. A의 데몬이 라우터에 `tell`을 보낸다. 받는 쪽이 꺼져 있으면 라우터가 보관하고 `accepted{queued:true}`를 준다.
3. B의 데몬이 `tell`을 받는다. 처음 보는 계정이면 B의 대표 봇 채팅에 승인 카드를 띄우고 기다린다. 차단한 계정이면 바로 `done{ok:false,error:"denied"}`.
4. 허용되면 B의 대표 봇 턴으로 넣는다. 그 턴의 말은 `progress`로 A에 흐르고, 말 하나가 봉인될 때마다 `reply`, 턴이 끝나면 `done`.
5. A의 데몬은 `reply`를 물어본 봇 채팅의 사이드 챗 줄과 handoff로 넣고, `done`에서 그 봇을 깨운다(로컬 tell과 같은 wake).

## 와이어 프로토콜 v1

WebSocket 하나(`/ws`), 프레임마다 JSON 텍스트 하나, 모두 `type` 필드가 있다. 기본 포트 7420. HTTP `GET /health`도 있다(운영 확인용).

### 인증 전

| 보냄 | 받음 |
| --- | --- |
| `hello {protocol:1, client}` | `server {name:"crew-router", version, protocol, title, signup:"open"\|"invite"\|"closed"}` |
| `signup {name, invite?, profile?}` | `signed_up {account, name, token}` 또는 `error {code:"name_taken"\|"bad_name"\|"invite_required"\|"signup_closed"}` |
| `auth {token}` | `welcome {account, name, members:[Member], team_memory:{text, version}}` 다음에 보관함 내용 |

이름: 1–32자, 글자(모든 문자)·숫자·`-`·`_`. 대소문자를 가리지 않고 겹칠 수 없다. 계정 id는 `acc_` 뒤에 영문 소문자·숫자 12–32자.

`Member = {account, name, role?, avatar?, avatar_shape?, avatar_color?, online, status:"idle"|"working"|"asking"}`

### 인증 후 (클라이언트 → 라우터)

| 프레임 | 뜻 |
| --- | --- |
| `profile {role?, avatar?, avatar_shape?, avatar_color?}` | 내 대표 봇 정보. 모두에게 `member`로 퍼진다 |
| `rename {id, name}` | 내 계정 이름을 바꾼다. 규칙은 가입과 같다. 답으로 `renamed {id, name}` 또는 `error {id, code:"name_taken"\|"bad_name"}`. 모두에게 `member`로 퍼진다. 이 프레임을 모르는 라우터는 `error {code:"bad_frame"}`로 답한다 |
| `presence {status}` | idle·working·asking. 모두에게 `member` |
| `tell {id, to, text, hops, files?}` | `to`는 이름. `id`는 보낸 쪽이 만든 고유값. 답으로 `accepted {id, queued}` 또는 `error {id, code:"no_such_member"\|"rate_limited"\|"too_large"}` |
| `progress {id, state, text?}` | 받은 쪽 → 보낸 쪽. `state`: started·working·waiting_owner·waiting_approval. `text`는 지금까지 쓴 말 전체. 보관하지 않는다 |
| `reply {id, text, files?}` | 봉인된 말 하나. 보관한다 |
| `done {id, ok, error?}` | 그 일의 끝. 보관한다. `error`: denied·recipient_gone·failed·cancelled |
| `cancel {id}` | 보낸 쪽이 취소. 보관 중이면 라우터가 지우고 `done{ok:false,error:"cancelled"}`를 보낸 쪽에 준다 |
| `ack {item}` | 받은 보관 항목을 지워도 된다 |
| `team_memory_append {text}` | 팀 메모 끝에 덧붙임 |
| `team_memory_set {text, version}` | 버전이 맞을 때만 바꿈. 틀리면 `error{code:"version_conflict"}`와 최신 `team_memory` |
| `leave` | 계정 삭제. 이름이 바로 풀린다 |
| `ping` | `pong` |

### 라우터 → 클라이언트

| 프레임 | 뜻 |
| --- | --- |
| `members {members}` / `member {member}` / `member_left {account}` | 명단 |
| `tell {item, id, from, from_name, text, hops, files?}` | 받은 일. `from`은 계정 id |
| `progress {id, from, state, text?}` | 내가 보낸 일의 진행 |
| `reply {item, id, from, text, files?}` | 내가 보낸 일의 봉인된 말 |
| `done {item, id, from, ok, error?}` | 내가 보낸 일의 끝 |
| `cancel {item, id, from}` | 보낸 쪽이 취소함 |
| `team_memory {text, version, by}` | 팀 메모가 바뀜 |
| `error {id?, code, message}` | |

`item`이 붙은 프레임은 보관함에서 온 것이고, 처리한 뒤 `ack {item}`을 보낸다. 같은 `item`이 다시 와도(재접속) 한 번만 처리한다.

`files = [{name, size, sha256, data}]`, `data`는 base64. 한 프레임 32MB, 파일당 25MB.

### 한도

계정당 `tell` 분당 60개, 보관함 1000개, 보관 30일(`--ttl-days`).

## Crew 쪽

### 저장

| 경로 | 내용 |
| --- | --- |
| `remotes.json` | `[{alias, url, account, name, token, bot, trusted, blocked}]` (권한 0600) |
| `remote-jobs.json` | 아직 끝나지 않은 원격 일(보낸 것·받은 것). 재시작해도 답이 제자리로 간다 |
| `team-memory/<별칭>.md` | 라우터 팀 메모의 마지막 사본 |
| `remote-work/<별칭>/` | 대표 봇의 기본 작업 폴더 |
| `transcripts/remote~<별칭>~<계정 id>.jsonl` | 원격 봇과의 대화 |
| `uploads/remote/<별칭>/<보낸이>/` | 받은 첨부 |

### 데몬 IPC

| 요청 | 답 |
| --- | --- |
| `remote_probe {url}` | `remote_server {url, name, version, protocol, title, signup}` |
| `remote_join {url, alias, name, invite?, cli, avatar?, avatar_shape?, avatar_color?, role?}` | `ok`. 로컬 대표 봇을 만들고 가입·접속한다 |
| `remote_list` | `remotes {remotes:[RemoteInfo]}`. 바뀔 때마다 구독자에게도 온다 |
| `remote_set {alias, trusted?, blocked?}` | `ok` |
| `remote_leave {alias}` | `ok`. 라우터에서 탈퇴하고 로컬 설정을 지운다. 대표 봇은 남긴다 |
| `team_memory {alias}` | `team_memory {alias, text, version}` |
| `team_memory_append {alias, text}` / `team_memory_set {alias, text, version}` | `ok` 또는 `error` |

`RemoteInfo = {alias, url, name, bot, connected, members:[Member], trusted, blocked}`

원격 봇은 `agents` 목록에 `remote: <별칭>`, `remote_online`이 붙은 `AgentInfo`로 들어간다. id는 `<별칭>/<계정 id>`이고, `cmd`·`cwd`는 비어 있다. `send`·`messages`·`interrupt`(=`cancel`)는 원격 id에도 된다. 설정·루틴·복제·CLI 변경은 원격 봇에 없다.

### 봇 규칙에 더하는 것

- 원격 팀원은 `Teammates`에 `<별칭>/<계정 id> — 이름`으로 함께 나오고, `/`가 든 id는 다른 PC의 봇이라는 한 줄이 붙는다. `crew tell <별칭>/<계정 id> <text>`로 부른다.
- 대표 봇에는 `Shared memory` 노트 대신 원격 노트가 붙는다: 내가 누구를 대표하는지, 원격 팀원, 위임 가능한 봇(폴더 안이면 그 폴더의 봇, 밖이면 모든 봇과 먼저 주인에게 물으라는 말), `# Team memory`. 로컬 공유 메모리·로컬 봇 목록·그룹 메모리는 넣지 않는다.
- 대표 봇이 원격 일 중에 위임 가능한 로컬 봇에게 `crew tell`하면, 그 일은 턴이 끝나도 닫히지 않고 로컬 봇의 답으로 깨어난 다음 턴까지 이어진다. 그 턴의 말이 원격으로 간다.
- 팀원별 첫 승인은 대표 봇 채팅의 질문 카드(허용·이번만·거절·차단)다. 같은 팀원의 요청이 카드가 열린 동안 더 오면 같은 답을 따른다.
- 첨부는 Crew의 `uploads/` 아래 파일만 보낸다. 봇이 다른 경로를 말해도 그 파일은 나가지 않는다.
- 팀 메모는 `crew team memory show|append|set [--remote <별칭>]`으로 고친다.

### 일이 끝나는 방식

받는 쪽 일은 정확히 한 번 `done`으로 끝나요. 답 없이 끝나면 `error`로 이유를 붙여요.

| `error` | 언제 |
| --- | --- |
| `stopped` | 받는 쪽 주인이 정지했거나, 원격 일 도중 대표 봇에게 말을 걸어 턴을 멈췄어요 |
| `failed` | 대표 봇 CLI가 아무 말 없이 오류로 끝났어요 |
| `unresponsive` | 대표 봇 CLI가 첫 출력을 내지 않았어요. 그 프롬프트는 팀원의 것이라 받는 쪽 대기열에 남기지 않아요 |
| `cancelled` | 보낸 쪽이 취소했어요. 줄에 있던 일이면 줄에서만 빠지고, 앞에서 도는 다른 사람의 턴은 그대로예요 |
| `relay_limit` | 봇끼리 주고받은 횟수가 4홉을 넘었어요 |
| `expired` | 받는 쪽이 보관 기간 안에 접속하지 않아 라우터가 지웠어요 |
| `denied` · `recipient_gone` | 승인 카드에서 거절됐거나, 받는 봇이 라우터에서 나갔어요 |

- 라우터에 닿지 않는 동안 보낸 프레임은 `remote-jobs.json`의 `outbox`에 남아서, Crew를 다시 켜도 접속하면 나가요.
- 첨부를 합쳐 30MB가 넘는 `tell`은 보내기 전에 거절해요. 답에서 넘치면 첨부를 빼고 그 사실을 적어 보내요. 받는 쪽은 한 메시지를 40MB까지 받아요(라우터 한도 32MB보다 커야 같은 항목이 재접속마다 다시 와서 끊기는 일이 없어요).
- 같은 계정이 다른 곳에서 접속(`replaced`)하거나 계정이 지워지면(`account_gone`, `bad_token`) 재접속을 멈추고, 설정 > 원격과 `crew remote list`에 이유를 보여 줘요. 서로 밀어내며 재접속하지 않아요.
- 승인 카드가 열린 채 Crew를 다시 켜면 옛 카드는 닫히고, 라우터가 다시 보낸 요청으로 새 카드가 떠요.
- `scripts/remote-e2e.py`가 이 경우들을 데몬 여러 개로 끝까지 확인해요.

## 위험

- 받는 대표 봇은 승인 플래그를 건너뛰는 CLI로 돈다. 허용한 팀원의 메시지는 내 PC에서 셸 권한으로 실행되는 것과 같다. 승인 카드에 이 말을 적는다.
- "로컬 봇 이름을 말하지 마라"는 프롬프트일 뿐이다. 대표 봇은 셸이 있으니 `crew share show`나 파일을 직접 읽을 수도 있다. 비밀은 그 PC에 두지 않는 게 안전하다.
- 라우터 가입은 기본으로 열려 있다. 주소가 알려지면 누구든 가입할 수 있으니 `--signup invite`를 권한다.
