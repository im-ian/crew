/** Name inside a crew note that a routine was switched on or off. */
export function routineSwitchName(text: string): string | null {
  const line = text.trim();
  const ko = line.match(
    /^[\u2018'](.+)[\u2019'] 루틴을 (?:켰|껐)습니다\.$/,
  );
  if (ko?.[1]) return ko[1];
  const en = line.match(
    /^Turned (?:on|off) the [\u201C"](.+)[\u201D"] routine\.$/,
  );
  if (en?.[1]) return en[1];
  return null;
}
