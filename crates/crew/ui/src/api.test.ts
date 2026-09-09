import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { api } = await import("./api");

const required = {
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
};

describe("api.setAgent", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("fills in the args the command requires but the caller may omit", async () => {
    await api.setAgent({ ...required, shape: "cloud", color: "#f60" });
    const [, args] = mocks.invoke.mock.calls[0];
    expect(args).toMatchObject({ cwd: null, unsetCwd: false, name: null });
  });

  it("keeps what the caller did pass", async () => {
    await api.setAgent({ ...required, cwd: "/tmp/bot", unsetCwd: false });
    const [, args] = mocks.invoke.mock.calls[0];
    expect(args).toMatchObject({ cwd: "/tmp/bot", unsetCwd: false });
  });
});
