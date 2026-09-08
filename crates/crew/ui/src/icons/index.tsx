// Icons copied from Lucide (https://lucide.dev), ISC licensed; `terminal` also
// carries Feather's MIT. Both notices live next to this file in ./LICENSE.
// Copy a path in when a view needs it rather than pulling in the package.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 14, children, ...rest }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function Terminal(props: Props) {
  return (
    <Icon {...props}>
      <path d="M12 19h8" />
      <path d="m4 17 6-6-6-6" />
    </Icon>
  );
}

export function CornerDownRight(props: Props) {
  return (
    <Icon {...props}>
      <path d="m15 10 5 5-5 5" />
      <path d="M4 4v7a4 4 0 0 0 4 4h12" />
    </Icon>
  );
}
