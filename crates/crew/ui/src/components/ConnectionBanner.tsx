type Props = {
  visible: boolean;
  detail: string;
};

export function ConnectionBanner({ visible, detail }: Props) {
  return (
    <div className="conn-banner-slot" role="status">
      {visible ? <div className="conn-banner">{detail}</div> : null}
    </div>
  );
}
