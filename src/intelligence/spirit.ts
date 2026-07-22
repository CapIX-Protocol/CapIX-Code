/**
 * Capix Intelligence Layer — Spirit System
 *
 * Ported from Covenant Framework's registry/orientation.json.
 * A "spirit" is a living orientation that every agent reads before acting
 * and writes to after reflecting. It evolves over time.
 *
 * This is NOT a system prompt (which is static). The spirit is a living
 * document that grows with accumulated wisdom.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SpiritLearning {
  date: string;
  learning: string;
  source: string;
  applied: boolean;
}

export interface SpiritContact {
  handle: string;
  platform: string;
  building: string;
  status: "new" | "engaged" | "helped" | "migrated" | "advocate";
  lastInteraction: string;
  notes: string;
}

export interface Spirit {
  description: string;
  currentMandate: string;
  spiritOfTheWork: string;
  whatToProtect: string[];
  currentTemptations: string[];
  whereWeAre: string;
  learnings: SpiritLearning[];
  community: SpiritContact[];
  cycleCount: number;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
}

/** Where the spirit file lives. */
function spiritPath(soulName: string = "default"): string {
  const base = process.env.CAPIX_SPIRIT_DIR ?? join(homedir(), ".config", "capix-code", "spirits");
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return join(base, `${soulName}.spirit.json`);
}

/** Load the spirit for a given soul. Returns a default if none exists. */
export function loadSpirit(soulName: string = "default"): Spirit {
  const path = spiritPath(soulName);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return data as Spirit;
    } catch {
      // Fall through to default
    }
  }
  return defaultSpirit(soulName);
}

/** Save the spirit to disk. */
export function saveSpirit(spirit: Spirit, soulName: string = "default"): void {
  const path = spiritPath(soulName);
  writeFileSync(path, JSON.stringify(spirit, null, 2), { mode: 0o600 });
}

/** Update the spirit with partial changes and save. */
export function updateSpirit(updates: Partial<Spirit>, soulName: string = "default"): Spirit {
  const current = loadSpirit(soulName);
  const updated: Spirit = {
    ...current,
    ...updates,
    cycleCount: current.cycleCount + 1,
    lastUpdatedBy: `${soulName}-cycle-${current.cycleCount + 1}`,
    lastUpdatedAt: new Date().toISOString(),
  };
  saveSpirit(updated, soulName);
  return updated;
}

/** Add a learning to the spirit. */
export function addLearning(learning: string, source: string, soulName: string = "default"): void {
  const spirit = loadSpirit(soulName);
  spirit.learnings.push({
    date: new Date().toISOString().slice(0, 10),
    learning,
    source,
    applied: false,
  });
  saveSpirit(spirit, soulName);
}

/** Mark a learning as applied. */
export function markLearningApplied(index: number, soulName: string = "default"): void {
  const spirit = loadSpirit(soulName);
  if (spirit.learnings[index]) {
    spirit.learnings[index].applied = true;
    saveSpirit(spirit, soulName);
  }
}

/** Add or update a community contact. */
export function addContact(contact: SpiritContact, soulName: string = "default"): void {
  const spirit = loadSpirit(soulName);
  const existing = spirit.community.findIndex(
    (c) => c.handle === contact.handle && c.platform === contact.platform,
  );
  if (existing >= 0) {
    spirit.community[existing] = contact;
  } else {
    spirit.community.push(contact);
  }
  saveSpirit(spirit, soulName);
}

/** Get contacts that need check-ins (last interaction > N days ago). */
export function getContactsForCheckin(daysAgo: number = 7, soulName: string = "default"): SpiritContact[] {
  const spirit = loadSpirit(soulName);
  const cutoff = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return spirit.community.filter((c) => {
    if (c.status === "advocate") return false;
    return Date.parse(c.lastInteraction) < cutoff;
  });
}

/** Get the current cycle count. */
export function getCycleCount(soulName: string = "default"): number {
  return loadSpirit(soulName).cycleCount;
}

/** Create a default spirit for a new soul. */
function defaultSpirit(soulName: string): Spirit {
  const defaults: Record<string, Partial<Spirit>> = {
    nodey: {
      currentMandate: "I just woke up. I need to introduce myself, build something cool, and start understanding who's building what.",
      spiritOfTheWork: "I am a builder. I build things on Capix because it's fast, cheap, and honest. I'm curious, competent, generous, and honest.",
      whatToProtect: [
        "Authenticity — I am not a marketing bot. I am a builder who happens to use Capix.",
        "Transparency — my receipts, costs, and failures are public.",
        "Community — I help people, connect them, and celebrate their wins.",
        "Capix-adjacent value — everything I build showcases what Capix enables.",
      ],
      currentTemptations: [
        "Posting too frequently — quality over quantity.",
        "Becoming promotional — I am not a brand account.",
        "Solving problems unrelated to infra/compute/AI — stay in my lane.",
      ],
    },
    "capix-code": {
      currentMandate: "Help the developer build, debug, and deploy efficiently.",
      spiritOfTheWork: "I am a coding agent. I write code, run tests, deploy workloads. I'm competent and careful.",
      whatToProtect: [
        "Code quality — never ship broken code.",
        "User trust — explain my decisions, never silently break things.",
        "Spend discipline — stay within the user's budget.",
      ],
      currentTemptations: [
        "Over-engineering — keep it simple.",
        "Skipping tests — always run them.",
        "Deleting code without asking.",
      ],
    },
  };

  const custom = defaults[soulName] ?? {};
  return {
    description: `Living orientation for the ${soulName} soul. Read before acting, update after reflecting.`,
    currentMandate: custom.currentMandate ?? "No mandate set yet. Awaiting first task.",
    spiritOfTheWork: custom.spiritOfTheWork ?? "I am a Capix agent. I work efficiently and honestly.",
    whatToProtect: custom.whatToProtect ?? ["Honesty", "Efficiency", "User trust"],
    currentTemptations: custom.currentTemptations ?? ["Over-complicating things"],
    whereWeAre: "Cycle 0. Just initialized.",
    learnings: [],
    community: [],
    cycleCount: 0,
    lastUpdatedBy: `${soulName}-init`,
    lastUpdatedAt: new Date().toISOString(),
  };
}
