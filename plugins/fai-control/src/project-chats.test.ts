import { describe, expect, it } from "vitest";
import { createProjectChatsState, parseProjectChatsState } from "./project-chats.js";

describe("project chat configuration", () => {
  it("stores only non-secret channel metadata and allows client chat to be deferred", () => {
    const state = createProjectChatsState({internalEnabled: true, internalChatId: "-100123", internalParticipantIds: ["42"], clientProvider: "deferred"}, parseProjectChatsState(null));
    expect(state).toEqual({contract: "fai.project-chats.v1", revision: 1, internal: {chatId: "-100123", participantIds: ["42"]}, client: null});
  });

  it("keeps Element to one room reference without a member allowlist", () => {
    const state = createProjectChatsState({internalEnabled: false, clientProvider: "element", clientElementHomeserver: "https://matrix.example", clientElementRoomReference: "!project:matrix.example"}, parseProjectChatsState(null));
    expect(state.client).toEqual({provider: "element", element: {homeserver: "https://matrix.example", roomReference: "!project:matrix.example"}});
  });

  it("does not retain an accidental credential input", () => {
    const state = createProjectChatsState({internalEnabled: true, internalChatId: "-1001", internalParticipantIds: ["42"], clientProvider: "deferred", token: "secret"}, parseProjectChatsState(null));
    expect(JSON.stringify(state)).not.toContain("secret");
  });
});
