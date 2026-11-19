import { BUILD_CATALOG, ITEMS } from "./index.js";
import type { SaveData } from "./index.js";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const vector = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(finite);
const strings = (value: unknown, max = 160): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length <= max);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const itemKey = (value: string): value is keyof typeof ITEMS => Object.prototype.hasOwnProperty.call(ITEMS, value);

/** Shared boundary check used before local persistence and before an untrusted cloud payload reaches SQLite. */
export function isValidSavePayload(raw: unknown): raw is SaveData {
  if (!object(raw) || (raw.version !== 1 && raw.version !== 2) || !finite(raw.savedAt) || !finite(raw.playSeconds) || !object(raw.player) || !object(raw.ship) || !object(raw.world) || !object(raw.home)) return false;
  const { player, ship, world, home } = raw;
  const level = player.level;
  const hp = player.hp, hunger = player.hunger, stamina = player.stamina, xp = player.xp;
  if (!vector(player.pos) || !finite(level) || !finite(hp) || !finite(hunger) || !finite(stamina) || !finite(xp) || !Number.isInteger(level) || level < 1 || level > 100 || hp < 0 || hp > 100 || hunger < 0 || hunger > 100 || stamina < 0 || xp < 0 || !["walk", "sail", "glide"].includes(player.mode as string)
    || !Array.isArray(player.inventory) || !player.inventory.every((stack) => {
      if (!object(stack)) return false;
      const count = stack.count;
      return typeof stack.id === "string" && itemKey(stack.id) && finite(count) && count > 0 && Number.isInteger(count);
    }) || player.inventory.length > 100 || new Set(player.inventory.map((stack) => (stack as { id: string }).id)).size !== player.inventory.length) return false;
  if (!vector(ship.pos) || !finite(ship.rotY) || typeof ship.docked !== "boolean" || typeof ship.sailUpgraded !== "boolean") return false;
  const personalParts = raw.home?.personalParts;
  if (personalParts !== undefined && (!Array.isArray(personalParts) || personalParts.length > 24 || !personalParts.every((part) => object(part) && typeof part.id === "string" && part.id.length > 0 && part.id.length <= 60 && typeof part.name === "string" && part.name.length > 0 && part.name.length <= 40
    && typeof part.file === "string" && part.file.startsWith("/") && part.file.length <= 200 && vector(part.size) && part.size.every((n) => n > 0 && n <= 50) && (part.prompt === undefined || (typeof part.prompt === "string" && part.prompt.length <= 600))))) return false;
  const knownPartIds = new Set<string>(BUILD_CATALOG.map((part) => part.id));
  for (const part of Array.isArray(personalParts) ? personalParts : []) knownPartIds.add((part as { id: string }).id);
  if (!Array.isArray(raw.buildings) || raw.buildings.length > 2_000 || !raw.buildings.every((building) => object(building) && typeof building.uid === "string" && building.uid.length > 0 && building.uid.length <= 120 && typeof building.partId === "string" && knownPartIds.has(building.partId) && typeof building.space === "string" && building.space.length <= 120 && vector(building.pos) && finite(building.rotY))
    || new Set(raw.buildings.map((building) => (building as { uid: string }).uid)).size !== raw.buildings.length) return false;
  if (!Array.isArray(raw.farm) || raw.farm.length > 100 || !raw.farm.every((farm) => object(farm) && typeof farm.id === "string" && farm.id.length <= 100 && (farm.crop === null || farm.crop === "wheat") && finite(farm.stage) && Number.isInteger(farm.stage) && farm.stage >= 0 && farm.stage <= 3 && finite(farm.plantedAt) && farm.plantedAt >= 0 && ((farm.crop === null && farm.stage === 0) || (farm.crop === "wheat" && farm.stage >= 1)))) return false;
  if (!strings(world.collected) || world.collected.length > 10_000 || new Set(world.collected).size !== world.collected.length || !strings(world.visited) || world.visited.length > 1_000 || !object(world.chests) || Object.keys(world.chests).length > 10_000 || !Object.entries(world.chests).every(([id, opened]) => id.length <= 160 && typeof opened === "boolean")) return false;
  if (world.islandMutations !== undefined && (!object(world.islandMutations) || Object.keys(world.islandMutations).length > 1_000 || !Object.entries(world.islandMutations).every(([key, mutation]) => {
    if (key.length > 160 || !object(mutation) || mutation.island !== key || !strings(mutation.collected) || mutation.collected.length > 10_000 || !object(mutation.chests) || !Array.isArray(mutation.buildings) || mutation.buildings.length > 1_000) return false;
    return Object.values(mutation.chests).every((opened) => typeof opened === "boolean") && mutation.buildings.every((building) => object(building) && typeof building.uid === "string" && typeof building.partId === "string" && vector(building.pos) && finite(building.rotY));
  }))) return false;
  const budget = home.buildBudget;
  if (!finite(home.level) || home.level < 0 || home.level > 10 || typeof home.upgradedBerth !== "boolean" || (home.buildZone !== null && !vector(home.buildZone)) || typeof home.authorized !== "boolean"
    || !(budget === null || (object(budget) && Object.keys(budget).length <= 32 && Object.entries(budget).every(([id, amount]) => finite(amount) && itemKey(id) && Number.isInteger(amount) && amount >= 0 && amount <= 1_000_000)))) return false;
  if (!Array.isArray(raw.npcs) || raw.npcs.length > 32 || !raw.npcs.every((npc) => object(npc) && typeof npc.id === "string" && npc.id.length <= 64 && vector(npc.pos) && typeof npc.state === "string" && finite(npc.affinity) && Array.isArray(npc.memory) && npc.memory.length <= 60 && npc.memory.every((memory) => object(memory) && finite(memory.t) && typeof memory.text === "string" && memory.text.length <= 600 && typeof memory.kind === "string" && memory.kind.length <= 64))) return false;
  if (!object(raw.quests) || Object.keys(raw.quests).length > 100 || !Object.values(raw.quests).every((quest) => {
    if (!object(quest)) return false;
    const step = quest.step;
    return finite(step) && Number.isInteger(step) && step >= 0 && strings(quest.done);
  }) || !object(raw.flags) || Object.keys(raw.flags).length > 200 || !Object.values(raw.flags).every((value) => typeof value === "boolean")) return false;
  if (player.foodBuff !== undefined && player.foodBuff !== null) {
    if (!object(player.foodBuff)) return false;
    const { stamina, remainingMs } = player.foodBuff;
    if (!finite(stamina) || !finite(remainingMs) || stamina < 0 || remainingMs < 0 || remainingMs > 86_400_000) return false;
  }
  if (raw.questFacts !== undefined && (!strings(raw.questFacts) || raw.questFacts.length > 1_000)) return false;
  if (world.worldId !== undefined && (typeof world.worldId !== "string" || world.worldId.length < 1 || world.worldId.length > 120)) return false;
  const energy = ship.energy;
  if (energy !== undefined && (!finite(energy) || energy < 0 || energy > 100)) return false;
  const allowedParts = home.buildAllowedParts;
  if (allowedParts !== undefined && (!strings(allowedParts) || !allowedParts.every((id) => BUILD_CATALOG.some((part) => part.id === id)))) return false;
  if (home.buildZoneRadius !== undefined && (!finite(home.buildZoneRadius) || home.buildZoneRadius < 1 || home.buildZoneRadius > 30)) return false;
  if (home.authorizationPaused !== undefined && typeof home.authorizationPaused !== "boolean") return false;
  const branchStates = new Set(["proposed", "approved", "executing", "paused", "blocked", "completed", "cancelled"]);
  if (home.projects !== undefined && (!Array.isArray(home.projects) || home.projects.length > 8 || !home.projects.every((project) => object(project) && typeof project.id === "string" && project.id.length > 0 && project.id.length <= 60
    && typeof project.branch === "string" && ["explore", "life", "craft", "society"].includes(project.branch)
    && typeof project.state === "string" && branchStates.has(project.state)
    && typeof project.built === "boolean" && Array.isArray(project.opIds) && project.opIds.length <= 40 && project.opIds.every((opId) => typeof opId === "string" && opId.length > 0 && opId.length <= 120)
    && (project.blockedReason === undefined || (typeof project.blockedReason === "string" && project.blockedReason.length <= 120))
    && finite(project.createdAt) && (project.completedAt === undefined || finite(project.completedAt))))) return false;
  if (home.expeditions !== undefined && (!Array.isArray(home.expeditions) || home.expeditions.length > 100 || !home.expeditions.every((expedition) => object(expedition) && typeof expedition.opId === "string" && expedition.opId.length > 0 && expedition.opId.length <= 120
    && typeof expedition.islandId === "string" && expedition.islandId.length > 0 && expedition.islandId.length <= 120 && finite(expedition.completedAt)))) return false;
  if (home.provisionedOpIds !== undefined && (!strings(home.provisionedOpIds, 120) || home.provisionedOpIds.length > 100)) return false;
  if (home.forgeUnlocked !== undefined && typeof home.forgeUnlocked !== "boolean") return false;
  if (home.pet !== undefined && home.pet !== null) {
    const pet = home.pet;
    if (!object(pet) || pet.species !== "fox" || typeof pet.name !== "string" || pet.name.length === 0 || pet.name.length > 40
      || typeof pet.space !== "string" || pet.space.length === 0 || pet.space.length > 120 || !vector(pet.pos)
      || !finite(pet.bondVisits) || !Number.isInteger(pet.bondVisits) || pet.bondVisits < 0 || pet.bondVisits > 1000
      || !Array.isArray(pet.bondIslands) || pet.bondIslands.length > 100 || !pet.bondIslands.every((island) => typeof island === "string" && island.length > 0 && island.length <= 120)
      || !["follow", "stay"].includes(pet.mode as string)) return false;
  }
  if (home.companion !== undefined && home.companion !== null) {
    const companion = home.companion;
    const flags = ["invited", "jointProject", "expeditionReturned", "jointWispKill", "rescueUsedThisExpedition"];
    if (!object(companion) || !flags.every((flag) => typeof companion[flag] === "boolean")) return false;
  }
  if (world.generatedTypesVisited !== undefined && (!strings(world.generatedTypesVisited, 40) || world.generatedTypesVisited.length > 16)) return false;
  if (world.journeyOpId !== undefined && (typeof world.journeyOpId !== "string" || world.journeyOpId.length === 0 || world.journeyOpId.length > 128)) return false;
  if (world.journeyDocks !== undefined && (!strings(world.journeyDocks, 120) || world.journeyDocks.length > 40)) return false;
  return true;
}
