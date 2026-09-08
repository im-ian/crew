# 아이콘

UI 아이콘은 [Lucide](https://lucide.dev)에서 **필요한 것만 복사**해서 쓰고 있어요.
패키지(`lucide-react`)는 설치하지 않아요.

## 왜 복사인지

지금 쓰는 아이콘이 두 개예요. 그걸 위해 의존성을 하나 늘리는 것보다, path 두 줄을
[`crates/crew/ui/src/icons/index.tsx`](../crates/crew/ui/src/icons/index.tsx)에 넣어 두는 쪽이
빌드도 가볍고 버전도 신경 쓸 게 없어요. 아이콘이 열댓 개로 늘어나면 그때 패키지로 바꾸면 돼요.

## 라이센스

Lucide는 **ISC**, 그중 Feather에서 온 아이콘은 추가로 **MIT** (© 2013–present Cole Bemis)예요.
둘 다 복사·수정·배포를 허용하고, **저작권 문구와 허가 문구를 사본에 포함할 것**을 요구해요.

원문 전체를 [`crates/crew/ui/src/icons/LICENSE`](../crates/crew/ui/src/icons/LICENSE)에 그대로 두었어요.
아이콘 파일을 옮기거나 복사할 때 이 파일도 같이 따라가야 해요.

## 지금 가진 아이콘

| 이름 | 쓰이는 곳 | 출처 |
| --- | --- | --- |
| `Terminal` | 말풍선 안 명령줄 앞 | Lucide (Feather 계열, ISC + MIT) |
| `CornerDownRight` | 명령 바로 아래 출력 블록 앞 | Lucide (Feather 계열, ISC + MIT) |

## 추가하는 법

1. [lucide.dev](https://lucide.dev/icons)에서 아이콘을 찾아 SVG를 복사해요.
2. `<path>` 들만 떼어서 `icons/index.tsx`에 컴포넌트로 추가해요. 나머지 속성
   (`viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width="2"`, 둥근 캡)은
   공통 `Icon` 래퍼가 이미 갖고 있어요.
3. 그 아이콘이 Feather 계열인지 확인해요. `LICENSE` 안 목록에 이름이 있으면 MIT도 함께 적용돼요.
4. 위 표에 한 줄 추가해요.

```tsx
export function Hash(props: Props) {
  return (
    <Icon {...props}>
      <line x1="4" x2="20" y1="9" y2="9" />
      ...
    </Icon>
  );
}
```

색은 `currentColor`, 크기는 `size` prop (기본 14px)이에요. 색을 줄 때는 아이콘에 직접 주지 말고
부모의 `color`를 쓰면 테마 토큰이 그대로 따라와요.

## 손으로 그린 SVG

Composer, ChatHeader, Sidebar 등에는 아직 인라인 SVG가 남아 있어요. Lucide로 바꿀 때는
위와 같은 방식으로 `icons/index.tsx`에 옮기고 표에 적어 주세요.
