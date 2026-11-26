# 릴리스와 macOS 서명

`vX.Y.Z` 태그를 올리면 Release 워크플로(`.github/workflows/release.yml`)가 Apple Silicon·Intel DMG, 업데이터 아카이브와 서명, `latest.json`을 GitHub Release에 올려요. 버전 맞추기와 업데이터 서명 키(`TAURI_SIGNING_PRIVATE_KEY`)는 [개발](development.md#패키징과-릴리스)에 있어요.

## Developer ID 서명과 공증

저장소 Secrets에 아래 여섯 개가 **모두** 있으면 다음 릴리스부터 Apple Developer ID로 서명하고 Apple 공증을 받아요. **하나도 없으면** 지금처럼 ad-hoc으로 빌드해요. **일부만** 있으면 릴리스가 멈추고 빠진 이름을 알려 줘요. 반쯤 넣은 키로 서명 안 된 앱이 나가지 않게 하려는 거예요.

| Secret | 값 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 인증서 `.p12`를 base64로 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12`를 내보낼 때 정한 암호 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 이름 (3Q67WDU8Z3)` |
| `APPLE_API_ISSUER` | App Store Connect API의 Issuer ID |
| `APPLE_API_KEY` | App Store Connect API 키의 Key ID |
| `APPLE_API_KEY_P8` | 그 키의 `AuthKey_<Key ID>.p8` 파일 내용 |

서명할 때 워크플로는 이렇게 해요.

1. 인증서를 이 작업만의 임시 키체인에 넣어요. 작업이 끝나면(실패해도) 지워요.
2. Tauri가 앱을 hardened runtime으로 서명하고, 공증을 받아 staple한 뒤, 그 앱으로 DMG와 업데이터 아카이브를 만들어요. 앱 안의 Mach-O는 `Contents/MacOS/crew` 하나예요. 데몬도 같은 바이너리(`crew daemon`)라 같이 서명돼요. entitlements는 쓰지 않아요.
3. DMG를 서명하고 공증·staple해요.
4. 앱, DMG, 업데이터 아카이브 속 앱을 다시 확인해요. Developer ID 서명, hardened runtime, 번들 안 모든 Mach-O의 서명, staple, Gatekeeper(`spctl`)를 봐요. 하나라도 틀리면 Release에 올리지 않아요.
5. Release 안내에서 "서명 안 됨, `xattr`" 문구를 빼요. 업데이터 서명과 `latest.json` 확인은 서명 여부와 상관없이 그대로 해요.

### 키 만들기

**Developer ID Application 인증서 (.p12)**

1. Mac의 키체인 접근 › 인증서 지원 › 인증 기관에서 인증서 요청을 골라, 이메일을 넣고 "디스크에 저장됨"으로 `.certSigningRequest`를 만들어요.
2. [developer.apple.com › Certificates](https://developer.apple.com/account/resources/certificates/list)에서 **+** › **Developer ID Application**을 고르고, 위 요청 파일을 올려 `.cer`를 받아요. 받은 파일을 열면 키체인에 들어가요.
3. 키체인 접근 › 로그인 › 내 인증서에서 `Developer ID Application: 이름 (3Q67WDU8Z3)`을 펼쳐 개인 키와 함께 선택하고, **내보내기**로 `.p12`를 만들어요. 이때 정한 암호가 `APPLE_CERTIFICATE_PASSWORD`예요.
4. 서명 이름을 확인해요. 출력의 따옴표 안이 `APPLE_SIGNING_IDENTITY`예요.

   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```

**App Store Connect API 키 (.p8)**

1. [App Store Connect › 사용자 및 액세스 › 통합 › App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)에서 팀 키를 만들어요. 역할은 **Developer**면 공증에 충분해요.
2. `AuthKey_<Key ID>.p8`을 받아요. 한 번만 받을 수 있어요.
3. 같은 화면의 **Issuer ID**와 키의 **Key ID**를 적어 둬요.

### Secrets 넣기

값은 파일이나 입력 프롬프트에서 읽게 해요. 채팅이나 셸 기록에 붙이지 않아요. `gh secret set 이름`을 값 없이 실행하면 화면에 보이지 않는 입력을 받아요.

```sh
repo=im-ian/crew
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --repo "$repo"
gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$repo"   # 프롬프트에 암호
gh secret set APPLE_SIGNING_IDENTITY --repo "$repo"       # 프롬프트에 Developer ID Application: 이름 (3Q67WDU8Z3)
gh secret set APPLE_API_ISSUER --repo "$repo"             # 프롬프트에 Issuer ID
gh secret set APPLE_API_KEY --repo "$repo"                # 프롬프트에 Key ID
gh secret set APPLE_API_KEY_P8 --repo "$repo" < AuthKey_XXXXXXXXXX.p8
gh secret list --repo "$repo"                             # 여섯 개 이름이 보이는지
```

넣은 뒤에는 `.p12`와 `.p8`을 안전한 곳에 두거나 지워요. `.p8`은 다시 받을 수 없으니 잃어버리면 키를 새로 만들어 `APPLE_API_KEY`·`APPLE_API_KEY_P8`을 바꿔요.

### 확인

- 다음 릴리스 로그의 "Check macOS signing secrets" 단계에 `macOS signing: signed`가 나와요. `unsigned`면 Secrets가 하나도 없는 거고, 일부만 있으면 그 단계가 빠진 이름을 대며 멈춰요.
- 공증은 키를 넣은 뒤 첫 릴리스에서 처음 실제로 돌아요. 그 실행에서 "Notarize disk image + verify signatures" 단계가 통과하는지 봐요.
- 받은 DMG에서 확인하려면 `spctl -a -vv -t open --context context:primary-signature Crew_*.dmg`와 `spctl -a -vv /Applications/Crew.app`이 `accepted`, `source=Notarized Developer ID`를 보여요.

### 서명으로 바뀐 뒤

- macOS는 서명이 바뀐 앱을 다른 앱처럼 볼 수 있어요. 서명된 첫 버전으로 업데이트하면 알림 같은 권한을 한 번 다시 물을 수 있어요.
- 앱 안 업데이터는 Tauri 업데이터 서명으로 확인해서, ad-hoc 버전에서 서명된 버전으로도 그대로 업데이트돼요.
- 서명된 릴리스가 나가면 README 설치 절의 `xattr` 안내와 `scripts/install-macos.sh`의 quarantine 제거는 더 필요 없어요. 그때 정리해요.
- 서명을 끄려면 여섯 Secrets를 모두 지워요. 다음 릴리스부터 ad-hoc으로 돌아가요.
