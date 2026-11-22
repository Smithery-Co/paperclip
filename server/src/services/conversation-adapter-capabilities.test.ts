import { afterEach, describe, expect, it } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import {
  CONVERSATION_ADAPTER_TYPES,
  conversationAdapterTypes,
  isConversationAdapter,
} from "./conversation-continuation.js";

/** A plugin adapter only needs the surface the registry stores. */
function externalAdapter(type: string, supportsConversationContinuation?: boolean): ServerAdapterModule {
  return {
    type,
    execute: async () => ({ exitCode: 0 }),
    testEnvironment: async () => ({ supported: true } as never),
    ...(supportsConversationContinuation === undefined ? {} : { supportsConversationContinuation }),
  } as unknown as ServerAdapterModule;
}

const registered: string[] = [];
function register(adapter: ServerAdapterModule) {
  registerServerAdapter(adapter);
  registered.push(adapter.type);
}

afterEach(() => {
  for (const type of registered.splice(0)) unregisterServerAdapter(type);
});

describe("conversation adapter capability", () => {
  it("keeps every first-party conversation harness", () => {
    for (const type of CONVERSATION_ADAPTER_TYPES) expect(isConversationAdapter(type)).toBe(true);
    expect(isConversationAdapter("paperclip_runner")).toBe(false);
  });

  it("derives the set from the capability an external adapter declares", () => {
    // `openhands` was missing from the first-party list, so its terminal runs
    // left an execution hold that no user message could settle.
    expect(isConversationAdapter("openhands")).toBe(false);
    register(externalAdapter("openhands", true));
    expect(isConversationAdapter("openhands")).toBe(true);
    expect(conversationAdapterTypes()).toContain("openhands");
    unregisterServerAdapter("openhands");
    registered.splice(registered.indexOf("openhands"), 1);
    expect(isConversationAdapter("openhands")).toBe(false);
  });

  it("does not treat an undeclared external adapter as a conversation adapter", () => {
    register(externalAdapter("some_webhook_adapter"));
    expect(isConversationAdapter("some_webhook_adapter")).toBe(false);
  });

  it("never repeats a type that is both first-party and declaring", () => {
    register(externalAdapter("codex_local", true));
    const types = conversationAdapterTypes();
    expect(types.filter((type) => type === "codex_local")).toHaveLength(1);
  });
});
