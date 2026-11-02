// Chat rooms: you plus several buddies in one window.
// When someone speaks, each buddy in turn sees everything said since it last spoke and either
// replies or passes. Buddies later in the order see earlier replies in the same round. Another
// round runs only if someone spoke, up to MAX_ROUNDS, so rooms can't loop forever.
import type { Runner, UserContent } from "./runner.js";
import type { AgentStore } from "./agents.js";

const MAX_ROUNDS = 2;
const MAX_ROOMS = 20;

interface Room {
  name: string;               // "#room-name"
  members: string[];          // buddy screen names (the user is always there)
  log: { from: string; text: string; blocks?: Exclude<UserContent, string> }[];
  cursor: Map<string, number>; // per member: index into log of what it has already seen
  queue: Promise<unknown>;
  generation: number;         // bumped by stop() so queued work bails out
}

export interface RoomInfo { name: string; members: string[]; busy: boolean }

export class Rooms {
  private rooms = new Map<string, Room>();
  private busy = new Set<string>();

  constructor(
    private runner: Runner,
    private store: AgentStore,
    private notify: { changed(): void; event(room: string, text: string): void },
  ) {}

  static normalize(name: string): string {
    const n = String(name || "").trim().replace(/^#*/, "").replace(/[^\w.\- ]/g, "").replace(/\s+/g, "-").slice(0, 24);
    return n ? `#${n.toLowerCase()}` : "";
  }

  list(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => ({ name: r.name, members: [...r.members], busy: this.busy.has(r.name) }));
  }

  get(name: string) { return this.rooms.get(name); }

  create(rawName: string, members: string[]): string {
    const name = Rooms.normalize(rawName);
    if (!name) throw new Error("Give the room a name.");
    if (!this.rooms.has(name)) {
      if (this.rooms.size >= MAX_ROOMS) throw new Error("Too many chat rooms open.");
      this.rooms.set(name, { name, members: [], log: [], cursor: new Map(), queue: Promise.resolve(), generation: 0 });
    }
    for (const m of members) this.invite(name, m, true);
    this.notify.changed();
    return name;
  }

  invite(room: string, who: string, quiet = false) {
    const r = this.rooms.get(room);
    const agent = this.store.get(who);
    if (!r || !agent || r.members.includes(agent.screenName)) return;
    r.members.push(agent.screenName);
    // newcomers get a little context, not the whole history
    r.cursor.set(agent.screenName, Math.max(0, r.log.length - 6));
    this.notify.event(room, `${agent.screenName} has entered the room.`);
    if (!quiet) this.notify.changed();
  }

  leave(room: string, who: string) {
    const r = this.rooms.get(room);
    if (!r) return;
    r.members = r.members.filter((m) => m !== who);
    this.runner.stop(who);
    this.notify.event(room, `${who} has left the room.`);
    this.notify.changed();
  }

  close(room: string) {
    this.stop(room);
    this.rooms.delete(room);
    this.runner.resetRoom(room);
    this.notify.changed();
  }

  removeBuddyEverywhere(who: string) {
    for (const r of this.rooms.values()) if (r.members.includes(who)) this.leave(r.name, who);
  }

  stop(room: string) {
    const r = this.rooms.get(room);
    if (!r) return;
    r.generation++;
    for (const m of r.members) this.runner.stop(m);
  }

  /** The user said something in the room. */
  say(room: string, me: string, text: string, blocks?: Exclude<UserContent, string>) {
    const r = this.rooms.get(room);
    if (!r) throw new Error(`No room ${room}`);
    r.log.push({ from: me, text, blocks: blocks?.length ? blocks : undefined });
    const gen = r.generation;
    r.queue = r.queue.then(() => this.converse(r, me, gen)).catch((e) => this.notify.event(room, `*** room error: ${(e as Error).message}`));
  }

  private async converse(r: Room, me: string, gen: number) {
    this.busy.add(r.name); this.notify.changed();
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let spoke = false;
        for (const m of [...r.members]) {
          if (gen !== r.generation) return;
          if (!r.members.includes(m)) continue;
          const fresh = r.log.slice(r.cursor.get(m) ?? 0).filter((e) => e.from !== m);
          r.cursor.set(m, r.log.length);
          if (!fresh.length) continue;
          const transcript = fresh.map((e) => `[${e.from}]: ${e.text}`).join("\n");
          const attached = fresh.flatMap((e) => e.blocks ?? []);
          const content: UserContent = attached.length ? [{ type: "text", text: transcript }, ...attached] : transcript;
          const reply = await this.runner.roomTurn(m, { name: r.name, members: [...r.members], me }, content);
          if (gen !== r.generation) return;
          if (reply.trim()) { r.log.push({ from: m, text: reply.trim() }); spoke = true; }
          r.cursor.set(m, r.log.length);
        }
        if (!spoke) break;
      }
    } finally {
      this.busy.delete(r.name); this.notify.changed();
    }
  }
}
