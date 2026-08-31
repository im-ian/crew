type Props = {
  text: string;
  show: boolean;
};

export function Toast({ text, show }: Props) {
  return <div className={"toast" + (show ? " show" : "")}>{text}</div>;
}
