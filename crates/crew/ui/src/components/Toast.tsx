type Props = {
  text: string;
  show: boolean;
  onClick?: () => void;
};

export function Toast({ text, show, onClick }: Props) {
  const cls = "toast" + (show ? " show" : "") + (onClick ? " is-action" : "");
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {text}
      </button>
    );
  }
  return <div className={cls}>{text}</div>;
}
