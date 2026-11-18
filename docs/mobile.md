# 휴대폰에서 Crew 쓰기

Crew를 켜 둔 Mac이 Crew 창과 같은 화면을 웹으로 내보내요. 휴대폰 브라우저로 열면(홈 화면에 추가하면 앱처럼) 같은 봇·대화·조작을 그대로 써요. 집 밖에서는 [Tailscale](https://tailscale.com)로 Mac에 닿아요. 공개 인터넷에는 아무 포트도 열지 않아요.

## 켜는 법

1. **Mac**: Tailscale을 켜고 로그인해 둬요.
2. **Crew 설정 › 모바일 › 모바일 접속**을 **켬**으로 바꿔요. 주소가 보여요. 예: `http://<Mac 이름>.<tailnet>.ts.net:47823` (MagicDNS)과 `http://100.x.y.z:47823`.
3. **휴대폰**: App Store / Play 스토어에서 Tailscale 앱을 깔고, Mac과 **같은 계정**으로 로그인해서 켜요.
4. Crew 설정의 **짝 코드 만들기**를 누르면 QR과 6자리 코드가 나와요(5분 동안, 한 번만 쓰여요).
   - 휴대폰 카메라로 QR을 찍으면 Crew가 열리면서 바로 짝지어져요.
   - 또는 휴대폰 브라우저로 주소를 열고 코드를 넣어요.
5. 짝지은 휴대폰은 **짝지은 기기**에 나와요. 잃어버렸거나 더 안 쓰면 **해제**를 눌러요. 그 휴대폰은 다시 짝짓기 전까지 아무것도 못 해요.

Mac이 잠들면 휴대폰에서도 닿지 않아요. 노트북 덮개를 닫아도 깨어 있게 하려면 전원에 연결해 두거나 macOS의 잠자기 설정을 바꿔요.

## 어떻게 동작하나

- Crew 데몬(앱 창이 닫혀 있어도 도는 프로세스)이 작은 웹 서버를 띄워요. 앱에 들어 있는 같은 UI 파일을 내보내고, 창이 부르는 명령(`invoke`)을 HTTP로 받아 같은 함수로 처리해요. 그래서 화면과 동작이 데스크톱과 같아요.
- 이 Mac의 **루프백(127.0.0.1)** 과 **Tailscale 주소**에서만 들어요. 모든 인터페이스(`0.0.0.0`)에는 열지 않아서 같은 와이파이의 다른 기기도 닿지 않아요.
- Tailscale이 나중에 켜지면 설정 화면을 열 때 그 주소로도 듣기 시작해요.
- 기본 포트는 47823이고, `~/Library/Application Support/crew/mobile.json`의 `port`로 바꿀 수 있어요.

웹에서 데스크톱과 다른 것:

| 기능 | 휴대폰에서 |
| --- | --- |
| 폴더 고르기 대화상자 | 없음. 경로를 직접 적어요 |
| Finder·브라우저로 열기 | 없음. Mac에서 무언가를 열게 되기 때문이에요 |
| 파일 첨부 | 휴대폰에서 고른 파일을 Mac의 Crew 홈 `uploads`에 올려요(한 번에 100MB까지) |
| 독 배지·메뉴 | 없음 |
| 모바일 접속 설정 | 데스크톱에서만 바꿔요 |

## 보안 모델

- **네트워크**: 휴대폰은 Tailscale(WireGuard로 암호화된 사설망)로만 닿아요. HTTP지만 오가는 내용은 Tailscale이 암호화해요.
- **같은 사용자만**: tailnet에는 다른 사람의 기기도 있을 수 있어요. 그래서 Tailscale 주소로 온 요청마다 `tailscale whois`로 보낸 기기의 사용자를 확인하고, 이 Mac 주인과 같은 Tailscale 사용자가 아니면 거절해요(403). Tailscale CLI가 없으면 이 확인은 건너뛰고 아래 기기 토큰만으로 판단해요.
- **기기 토큰**: 짝 코드로 짝지으면 휴대폰에 기기 토큰이 쿠키(`HttpOnly`, `SameSite=Strict`, 1년)로 저장돼요. Mac에는 토큰의 SHA-256 해시만 `mobile-devices.json`에 남아요. 토큰 없이는 화면 파일 말고 아무 API도 못 불러요(401).
- **짝 코드**: 6자리, 5분, 한 번만. 한 코드에 5번 틀리면 그 코드는 버려지고, 10분 동안 모두 합쳐 20번 틀리면 새 코드를 만들 때까지 짝짓기가 막혀요.
- **다른 사이트에서 오는 요청**: 쿠키는 다른 사이트에서 보내지지 않고(`SameSite=Strict`), `Host`가 이 Mac의 이름·주소가 아니면 거절해요(DNS rebinding 방지).
- **파일 보기**(`/api/file`): Crew 홈, 사용자 홈, `/tmp` 아래 파일만 보여 줘요. 그 안에서도 점(`.`)으로 시작하는 폴더(`.ssh`, `.aws`, `.git` 등)는 안 돼요. 링크를 따라가 밖으로 나가는 경로도 막아요. 보여 주는 파일에는 스크립트가 돌지 않게 sandbox CSP를 붙여요.

## 개발

- 서버: `crates/crew/src/web.rs`. 명령 디스패치: `crates/crew/src/web_dispatch.rs`(생성 파일).
- 창 명령을 새로 만들면 `crates/crew`에서 `python3 scripts/gen_web_dispatch.py`를 돌려요. 안 돌리면 `every_window_command_has_a_web_answer` 테스트가 실패해요. 창이 필요하거나 Mac에서 무언가를 여는 명령은 `web.rs`의 `run_command`에 웹용 답을 두고 생성기의 `SPECIAL`에 넣어요.
- 개발 빌드에 UI가 묻혀 있지 않으면 `CREW_WEB_DIST=<빌드한 ui/dist>`로 그 폴더를 대신 내보내요.

### HTTP 계약

| 요청 | 답 |
| --- | --- |
| `GET /`, 앱 경로 | 빌드된 UI. `index.html`이 앱 스크립트보다 먼저 `/crew-web.js`(`window.__CREW_WEB__ = true`)를 불러요 |
| `GET /api/session` | 짝지은 기기면 200 `{ device }`, 아니면 401 |
| `POST /api/pair` `{ code, name? }` | 200 `{ device }` + 기기 쿠키 / 403 틀림·만료 / 429 시도 초과 |
| `POST /api/invoke/<command>` | 본문 = `invoke`의 인자 객체(camelCase). 200 = 반환값 JSON, 실패 4xx/5xx `{ error }` |
| `GET /api/file?path=<절대 경로>` | 허용된 파일. `Range` 지원(206) |
| `POST /api/upload` | 본문 = 파일 바이트와 `?name=<파일 이름>`, 또는 `multipart/form-data`의 첫 파일 칸. 200 `{ path }`, 100MB 넘으면 413 |

QR은 `<주소>/?pair=<코드>` 링크예요. 웹 UI가 `pair`를 읽어 바로 짝지어요.
