# 아이콘

UI 아이콘은 [Lucide](https://lucide.dev)에서 필요한 것만 복사해서
[`crates/crew/ui/src/icons/index.tsx`](../crates/crew/ui/src/icons/index.tsx)에 두고 써요.
패키지(`lucide-react`)는 설치하지 않아요. 쓰는 아이콘이 곧 그 파일의 export 목록이에요.

## 라이센스

Lucide는 **ISC**, 그중 Feather에서 온 아이콘은 추가로 **MIT** (© 2013–present Cole Bemis)예요.
둘 다 복사·수정·배포를 허용하고, **저작권 문구와 허가 문구를 사본에 포함할 것**을 요구해요.

원문 전체가 [`crates/crew/ui/src/icons/LICENSE`](../crates/crew/ui/src/icons/LICENSE)에 있어요.
아이콘 파일을 옮기거나 복사할 때 이 파일도 같이 따라가야 해요. 어떤 아이콘이 Feather 계열인지는
그 파일 안 목록에 이름이 있는지로 확인해요.

## 추가하는 법

1. [lucide.dev](https://lucide.dev/icons)에서 아이콘을 찾아 SVG를 복사해요.
2. `<path>` 들만 떼어서 `icons/index.tsx`에 컴포넌트로 추가해요. 나머지 속성
   (`viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width="2"`, 둥근 캡)은
   공통 `Icon` 래퍼가 이미 갖고 있어요.

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

크기는 `size` prop (기본 16px), 색은 `currentColor`예요. 색을 줄 때는 아이콘에 직접 주지 말고
부모의 `color`를 쓰면 테마 토큰이 그대로 따라와요.

윤곽선이 의미를 흐리는 자리에서는 채워도 돼요. 중지 버튼(`StopSquare`)이 그런 경우로,
Lucide의 `square`를 그대로 두면 "정지"가 아니라 그냥 사각형으로 읽혀요.
