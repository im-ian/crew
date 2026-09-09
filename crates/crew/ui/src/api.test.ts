import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const face = {
  id: "bot-3",
  model: null,
  effort: null,
  unsetModel: false,
  unsetEffort: false,
  title: null,
  role: null,
  description: null,
  unsetTitle: false,
  unsetRole: false,
  unsetDescription: false,
  shape: "cloud",
  color: "#f60",
  cwd: null,
  unsetCwd: false,
};

describe("api.setAgent", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("passes the whole payload to set_agent", async () => {
    await api.setAgent(face);
    // Whole payload, not a spot check: `set_agent` rejects a missing key, and
    // a wrapper that hand-picked which ones to forward is what broke it.
    expect(mocks.invoke.mock.calls[0]).toEqual(["set_agent", face]);
  });

  it("carries a caller's unsetCwd rather than a default", async () => {
    await api.setAgent({ ...face, cwd: null, unsetCwd: true });
    const [cmd, args] = mocks.invoke.mock.calls[0];
    expect(cmd).toBe("set_agent");
    expect(args).toMatchObject({ unsetCwd: true });
  });
});
