import { describe, expect, it } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import { QuestSystem } from "../src/gameplay/quests";

describe("QuestSystem", () => {
  it("retains an early fact and advances once its prerequisites arrive", () => {
    const engine = new NullEngine();
    const quests = new QuestSystem(new Scene(engine));

    quests.mark("blueprint_found");
    expect(quests.has("blueprint_found")).toBe(true);

    quests.mark("talked_npc_first");
    quests.mark("boarded_ship");
    quests.mark("windcrystal_3");
    expect(quests.states.first_expedition.step).toBe(4);
    expect(quests.has("blueprint_found")).toBe(true);
    engine.dispose();
  });

  it("does not duplicate a fact when the same event is replayed", () => {
    const engine = new NullEngine();
    const quests = new QuestSystem(new Scene(engine));
    quests.mark("talked_npc_first");
    quests.mark("talked_npc_first");
    expect(quests.states.first_expedition.done).toEqual(["talked_npc_first"]);
    engine.dispose();
  });
});
