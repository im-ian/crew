import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { botLabel } from "./botLabel";
import type { AgentInfo, Group } from "./types";

type LabelCtx = {
  groups: readonly Group[];
  /** The bot whose chat this is. Bots in its group go by their name alone. */
  viewer: string | null;
};

// Without a provider (a chip drawn off-tree) a bot goes by its name.
const Ctx = createContext<LabelCtx>({ groups: [], viewer: null });

/** `groups` left out keeps the outer ones, for a part of the screen that is another bot's. */
export function BotLabelProvider({
  groups,
  viewer,
  children,
}: {
  groups?: readonly Group[];
  viewer: string | null;
  children: ReactNode;
}) {
  const outer = useContext(Ctx);
  const shared = groups ?? outer.groups;
  const value = useMemo(() => ({ groups: shared, viewer }), [shared, viewer]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBotLabel(): (agent: AgentInfo) => string {
  const { groups, viewer } = useContext(Ctx);
  return useCallback((agent: AgentInfo) => botLabel(agent, groups, viewer), [groups, viewer]);
}

export function useLabelGroups(): readonly Group[] {
  return useContext(Ctx).groups;
}
