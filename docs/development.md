# 개발

## 소스에서 빌드해 설치

미리 빌드된 앱 대신 저장소에서 한 번에 빌드해 설치할 수 있어요. 요구사항은 **Rust** stable (`rustup`, rustc 1.95에서 확인), **Node.js** 20+, **Xcode Command Line Tools**예요. 스크립트는 없는 것을 채운 뒤 릴리스 바이너리를 `~/.local/bin/crew`에 넣어요.

```bash
git clone https://github.com/im-ian/crew.git
cd crew
./scripts/setup-macos.sh
```

이미 켜 둔 셸에서 실행하면 그 PATH의 Rust와 Node를 써요. Rust가 없으면 rustup으로, Node가 없고 Homebrew가 있으면 `brew install node`로 설치해요. Xcode Command Line Tools가 없으면 설치 창을 띄우고 끝나니, 설치가 끝난 뒤 같은 명령을 다시 실행해요. 바이너리 위치는 `CREW_BIN_DIR`로 바꿀 수 있어요. 릴리스 설치 스크립트가 만들어 둔 `~/.local/bin/crew` 링크가 있으면, 그 링크는 소스 빌드 바이너리로 바뀌어요.

`build.rs`가 `crates/crew/ui`에서 `npm install`과 `npm run build`를 실행해요. 첫 빌드는 Node 의존성 때문에 시간이 좀 더 걸려요.

체크아웃 없이 바이너리만 받으려면:

```bash
cargo install --git https://github.com/im-ian/crew.git --locked crew
```

`cargo install`은 `~/.cargo/bin/crew`에 설치해요. rustup으로 설치했다면 이미 PATH에 잡혀 있어요.

## 개발 실행과 테스트

```bash
cargo run -p crew          # 디버그. UI는 Vite http://127.0.0.1:1420
cargo test -p crew
(cd crates/crew/ui && npm test)
```

디버그 빌드는 `ui/dist`가 있으면 프론트엔드를 다시 번들하지 않고 창을 Vite에 연결해요. 릴리스 빌드는 `npm run build`로 `ui/dist`를 만들어요.

```
crates/crew/src/     Rust: CLI, 데몬, 헤드리스/PTY, Tauri 커맨드
crates/crew/ui/src/  React 19 UI
```

## 패키징과 릴리스

macOS `.app` / `.dmg`는 `./scripts/build-macos.sh`로 만들어요. 서명 키가 없으면 업데이터 아티팩트 없이 호스트 아키텍처 번들만 나와요.

GitHub에 `vX.Y.Z` 태그를 올리면 Release 워크플로가 Apple Silicon·Intel DMG와 업데이터 `latest.json`을 게시해요. `Cargo.toml`, `crates/crew/tauri.conf.json`, `crates/crew/ui/package.json`의 버전이 태그와 같아야 해요. 업데이터 서명을 쓰려면 저장소 Secrets에 `TAURI_SIGNING_PRIVATE_KEY`가 있어야 해요.

README 그림은 `docs/readme/*.html`을 고친 뒤 `docs/readme/render.sh`로 다시 만들어요.
