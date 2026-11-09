// The data contract. Every data source (the simulator now, BeatKhana next) produces an `OverlayData`,
// and every scene binds to it by path, e.g. {a.name}, {map.progress}, {pool.3.state}.
// Keep this file and docs/DESIGNING.md in sync: it is the designer's vocabulary.

export type Side = "a" | "b";

/** One person in a team's lineup for the current (or next) map. */
export interface PlayerData {
  name: string;
  avatar: string;
  // live while the map is played (from TA), or the final score once entered
  score: number;
  acc: number | null;
  combo: number;
  misses: number;
  finished: boolean;
}

export interface SideData {
  name: string;           // the team (in a 1v1, the player)
  players: PlayerData[];  // who plays the current/next map for this side (1 in a 1v1, 2 in duos, …)
  roster: string[];       // everyone on the team
  avatar: string;          // image URL ("" = none)
  initials: string;
  country: string;         // ISO alpha-2
  seed: number | null;
  points: number;          // maps won in this match
  // live, while a map is played (0 otherwise)
  score: number;
  acc: number | null;      // 0..1, null before the map starts (shows as —)
  combo: number;
  maxCombo: number;
  misses: number;          // misses + bad cuts
  health: number;          // 0..1
  finished: boolean;       // this player's score for the current map is in
  leading: boolean;        // ahead on the current map
  winner: boolean;         // won the match
}

export interface MapData {
  hash: string;
  name: string;
  artist: string;
  mapper: string;
  difficulty: string;      // "Expert+"
  category: string;        // "Tech" … (BeatKhana: the map's flair)
  cover: string;
  bpm: number;
  nps: number;
  length: string;          // "3:35"
  duration: number;        // seconds
}

export interface PoolItem extends MapData {
  state: "available" | "banned" | "picked" | "tiebreaker" | "current" | "played";
  by: Side | null;         // who picked/banned it
  byName: string;
  order: number | null;    // play order (1-based) for picked maps
  winner: Side | null;     // for played maps
  winnerName: string;
}

/** A map slot of the best-of, played or not. */
export interface MapSlot {
  number: number;          // 1-based
  state: "played" | "current" | "upcoming" | "unneeded";   // unneeded = the match was decided without it
  label: string;           // "MAP 2", or "TB" for the tiebreaker slot
  tiebreaker: boolean;
  name: string;            // the map, once known ("" before it is picked)
  winner: Side | null;
  winnerName: string;
}

export interface ResultItem {
  index: number;           // 1-based map number
  map: MapData;
  winner: Side | null;
  winnerName: string;
  pickedBy: Side | null;
  a: { acc: number; score: number; misses: number };
  b: { acc: number; score: number; misses: number };
}

export interface OverlayData {
  tournament: { name: string; short: string; round: string };
  match: {
    label: string;
    bestOf: number;
    need: number;          // maps needed to win
    phase: "idle" | "picks" | "waiting" | "loading" | "playing" | "finished" | "done";
    mapNumber: number;     // 1-based number of the current/next map
    winner: Side | null;
    winnerName: string;
    maps: MapSlot[];       // one per map of the best-of: "MAP 1 / MAP 2 / MAP 3" tabs
    playersPerMap: number; // 1 = a 1v1, 2 = duos, …
    solo: boolean;         // playersPerMap is 1 (handy for show:/hide:)
  };
  a: SideData;
  b: SideData;
  diff: number;            // a.acc - b.acc while playing
  tug: number;             // 0..1, 0.5 = even; ±2 % accuracy fills it
  // current or next map; pickedBy/pickedByName: the side that picked it (null/"" for the tiebreaker)
  map: (MapData & { progress: number; time: string; pickedBy: Side | null; pickedByName: string; tiebreaker: boolean }) | null;
  pool: PoolItem[];
  picks: {
    next: { type: "pick" | "ban"; verb: "picking" | "banning"; by: Side; byName: string } | null;
    done: boolean;
    steps: { type: "pick" | "ban"; by: Side; byName: string; done: boolean; current: boolean }[];
  };
  results: ResultItem[];
  last: ResultItem | null;  // the most recent map result
  upNext: { label: string; a: string; b: string }[];
  bracket: BracketData | null;
  feeds?: Record<string, string>;        // video holes the data fills itself: "a1" -> a replay viewer URL (TA live, or mock)
  feedsStartAt?: number;                 // epoch ms of song time 0 for those feeds, so every overlay shows the same moment
}

/**
 * Live gameplay pushed in by a TA bridge (or tools/mock-ta) with the "live" action. Merged over the source's data
 * while a map is being played: per-player numbers, the song clock, and what each video hole shows.
 */
export interface LiveState {
  matchId?: string;                       // only applies while the overlay follows this match
  phase: "loading" | "playing" | null;    // null = nothing live
  time?: number; duration?: number;       // song clock, seconds
  players?: { a?: Partial<PlayerData>[]; b?: Partial<PlayerData>[] };
  feeds?: Record<string, string>;
  startedAt?: number;                     // epoch ms when song time 0 happens (keeps every overlay's replay in sync)
}

/** Who played what, for a replay in the playlist (from BeatLeader, or a .bsor file's header). */
export interface ReplayInfo {
  source: "beatleader" | "scoresaber" | "file";
  song: string; subName: string; artist: string; mapper: string; cover: string;
  difficulty: string; stars: number | null; duration: number;
  player: string; playerAvatar: string; country: string;
  acc: number | null; fc: boolean; misses: number | null;
}
export interface PlaylistItem { id: string; ref: string; info: ReplayInfo | null; error?: string }
export interface Playlist {
  items: PlaylistItem[];
  mode: "order" | "shuffle" | "repeat";   // what plays when a song ends
  current: {
    id: string;
    startAt: number | null;               // epoch ms of song time 0 (null: waiting for the viewer to load)
    pausedAt: number | null;              // song seconds while no replay scene is on stream
    duration: number;                     // seconds
    switchedAt: number;                   // when it became current (the "up next" card shows from here)
    ready: boolean;                       // an overlay's viewer has it loaded
  } | null;
}

/**
 * A bracket, round by round (1 = first round). Single elimination: `rounds` is every round, the final last.
 * Double elimination (`double`): `winners` and `losers` are the two brackets' rounds and `final` the grand final
 * (a second match if the bracket has a reset); `rounds` is then the winners bracket plus the grand final.
 */
export interface BracketData {
  name: string;
  double: boolean;
  rounds: BracketRound[];
  winners: BracketRound[];
  losers: BracketRound[];
  final: BracketMatch[];
}
export interface BracketRound { name: string; matches: BracketMatch[] }
export interface BracketMatch {
  a: string; b: string;                   // team names ("TBD" until known)
  aScore: number | null; bScore: number | null;
  winner: Side | null;
  state: "upcoming" | "live" | "done";
  current: boolean;                       // the match this overlay is following
}

/** What's on stream: set from the panel, never by a data source. */
export interface ShowState {
  scene: string;
  auto: boolean;                          // run the automation rules in overlay.yaml
  header: string;                         // the top bar's event text ("MSU BEAT SABER · WINTER SESSION"); "" = the round
  casters: Caster[];
  castersFrom: "panel" | "discord";       // discord = the caster bot keeps the list in sync with the voice channel
  brb: { title: string; message: string; endsAt: number };
  ticker: string[];
  feeds: Record<string, string>;          // feed:a / feed:main … -> a URL set in the panel (overrides the data's)
  playlist: Playlist;                     // Starting Soon / Intermission / BRB replays (server/playlist.ts)
  replays?: string[];                     // (older show.json files: the playlist as plain links)
  streamDelayMs: number;                  // how far behind live the player streams are
  /** The Casters scene's "up next" block, typed in the panel (the overlay can't know whose match is next). Two team
   *  names, or a line of text; all empty = the block is hidden. Scenes read it as `nextUp.…` */
  upNext: { a: string; b: string; text: string };
  // every replay viewer: hold the up/down look near level (degrees); resolution (1 = full) and frame cap, which a
  // stream PC drawing replays on the CPU (OBS on Linux + NVIDIA) needs lower
  viewer: { lockPitch: boolean; pitchLimit: number; renderScale: number; maxFps: number;
    /** the panel preview's replays: "program" = pictures of the on-air overlay's own (light), "live" = its own viewers */
    preview: "program" | "live";
    /** the resolution replays are drawn for, whatever screen or window the overlay is on: an output height (720,
     *  1080, 1440, 2160) or 0 = the screen's own pixels (a 4K screen at 150 % then draws 1.5× the 1080p pixels) */
    output: number;
    /** ChroViewer's quality: the floor mirror's reflection, "high" (2048 px, smoothed) / "medium" (1024) / "low" (512,
     *  fewer things reflected) / "none" (off); and its screen distortion effects (heat-haze style walls/notes) */
    quality: "high" | "medium" | "low" | "none"; distortion: boolean };
}

/** A caster on screen. From the Discord bot: everyone in the casting voice channel, speaking lit up live. */
export interface Caster {
  id: string;            // Discord user id ("" when typed in the panel)
  name: string;
  handle: string;
  avatar: string;        // image URL (their Discord picture)
  speaking: boolean;
}

/** Things that happen; scenes react to them with `on:` rules. */
export type OverlayEvent =
  | "matchStart" | "mapPick" | "mapBan" | "picksDone" | "mapLoad" | "mapStart" | "songEnd" | "mapEnd" | "matchEnd"
  | "replay" | "timeout";

export interface EventMsg {
  name: OverlayEvent;
  item?: number;          // pool index for mapPick/mapBan
  side?: Side;
}

export interface DataSource {
  readonly name: string;
  start(emit: (data: OverlayData) => void, event: (e: EventMsg) => void): Promise<void>;
  stop(): Promise<void>;
  /** Source-specific controls (the simulator's buttons). */
  control?(action: string, args: Record<string, unknown>): Promise<void> | void;
  status(): string;
}

export const blankSide = (): SideData => ({
  name: "TBD", players: [], roster: [], avatar: "", initials: "?", country: "", seed: null, points: 0,
  score: 0, acc: null, combo: 0, maxCombo: 0, misses: 0, health: 0.5, finished: false, leading: false, winner: false,
});

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
