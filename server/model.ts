// The data contract. Every data source (the simulator now, BeatKhana next) produces an `OverlayData`,
// and every scene binds to it by path, e.g. {a.name}, {map.progress}, {pool.3.state}.
// Keep this file and docs/DESIGNING.md in sync: it is the designer's vocabulary.

export type Side = "a" | "b";

/** One person in a team's lineup for the current (or next) map. */
export interface PlayerData {
  name: string;
  avatar: string;
  /** Their own saber colours ("#rrggbb"), where they chose any (BSCompStats, Teams page): their replay is drawn in them. */
  sabers?: { left: string; right: string } | null;
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
  /** The team's mark: "star" (the default), "msu" (the MSU Esports shield) or "image" (`logo` is its address). */
  logoKind: "star" | "msu" | "image";
  logo: string;            // image URL when logoKind is "image", else ""
  /** Replays this team's players chose to show on stream (viewer links): the playlist plays them while it is up next. */
  replays: string[];
  initials: string;
  country: string;         // ISO alpha-2
  seed: number | null;
  points: number;          // maps won in this match
  /** Match points on the current (or last) map: the team's mean points. Null unless the match is scored on match
   *  points and the map has a perfect accuracy. Live while a map is played. */
  matchPoints: number | null;
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
    /** How maps are decided: "accuracy" (the lineup's mean accuracy) or "points" (BSCompStats' match points: each
     *  player's accuracy goes through the curve first, then the points are averaged). Under "points" a side's `acc`
     *  is the accuracy that earns its mean points, not the plain average. */
    scoring?: "accuracy" | "points";
    /** The match points curve, and what counts as perfect on the current map (0..1; null = none set). */
    curve?: { padding: number; slope: number; perfectPoints: number } | null;
    perfectAcc?: number | null;
    solo: boolean;         // playersPerMap is 1 (handy for show:/hide:)
    /** While phase is "loading", how far TA is: "waiting" (a player hasn't joined TA yet), "loading" (their games
     *  are fetching the map), "ready" (everyone has it; the organiser can start the song). "" otherwise. */
    load: "" | "waiting" | "loading" | "ready";
  };
  a: SideData;
  b: SideData;
  diff: number;            // a.acc - b.acc while playing
  tug: number;             // 0..1, 0.5 = even; a lead of TUG_FULL (10 % accuracy) fills it
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
  /** Every team entered in the tournament, with its mark and its players' showcase replays. */
  teams?: TeamInfo[];
  feeds?: Record<string, string>;        // video holes the data fills itself: "a1" -> a replay viewer URL (TA live, or mock)
  feedsStartAt?: number;                 // epoch ms of song time 0 for those feeds, so every overlay shows the same moment
  /** A TA-mode match: each lineup player's live replay stream, per video hole ("a1" -> their TA platform id), and
   *  the TA server ("host:port"). The server turns these into replay-viewer links (feeds) that follow the player. */
  taLive?: { relay: string; players: Record<string, string> } | null;
}

/**
 * Live gameplay pushed in by a TA bridge (or tools/mock-ta) with the "live" action. Merged over the source's data
 * while a map is being played: per-player numbers, the song clock, and what each video hole shows.
 */
export interface LiveState {
  matchId?: string;                       // only applies while the overlay follows this match
  phase: "loading" | "playing" | null;    // null = nothing live
  load?: "waiting" | "loading" | "ready";  // while loading: how far (see OverlayData.match.load)
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
export interface TeamInfo { name: string; logoKind: SideData["logoKind"]; logo: string; replays: string[] }
/** `team`: the replay came from that team's players (the data source), not from the panel's own list. */
export interface PlaylistItem { id: string; ref: string; info: ReplayInfo | null; error?: string; team?: string }
export interface Playlist {
  items: PlaylistItem[];
  /** Play the teams' own replays: the two teams that are up next while there are some, else the panel's list. */
  followTeams?: boolean;
  /** What is being played from right now (worked out by the server, for the panel). */
  scope?: { kind: "teams" | "special" | "all" | "none"; teams: string[] };
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
  /** The stream is ending: the Final scene adds THANKS FOR WATCHING. Off for every other match of the day. */
  signOff?: boolean;
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
  /** Staging ("studio mode"): while on, the panel's scene buttons and text cards edit `staged` instead of what is on
   *  air, and "Go live" (the take action) applies it in one step. */
  staging?: boolean;
  /** The staged copy of everything the operator sets by hand (null/undefined = nothing staged: Next equals On air). */
  staged?: StagedShow | null;
  // every replay viewer: hold the up/down look near level (degrees); resolution (1 = full) and frame cap, which a
  // stream PC drawing replays on the CPU (OBS on Linux + NVIDIA) needs lower
  /** Sound: how loud the replays' music is. `music` for everything (1 = as recorded), times the on-air scene's own
   *  figure in `scenes` (a scene not listed is 1): Getting Ready is quieter, a breather before the song. */
  mix?: { music: number; /** the hitsounds' level, apart from the music's */ hits?: number; scenes: Record<string, number> };
  viewer: { lockPitch: boolean;
    /** how far the replay camera may look up and down from level, in degrees (they need not be the same) */
    pitchUp: number; pitchDown: number;
    /** (older show.json files: one limit for both) */
    pitchLimit?: number;
    /** showing a limit: every viewer's camera sits at the "up" or "down" limit until `until` (epoch ms); never saved */
    pitchHold?: { dir: "up" | "down"; until: number } | null;
    /** the replay camera's field of view in degrees (30 to 120; ChroViewer's own default is 70) */
    fov?: number;
    /** how far the replay camera sits in front of the player's head, in metres along the track (negative = behind
     *  it; ChroViewer's own default is -0.55). World space: it does not turn with where the player looks */
    z?: number;
    renderScale: number; maxFps: number;
    /** the resolution replays are drawn for, whatever screen or window the overlay is on: an output height (720,
     *  1080, 1440, 2160) or 0 = the screen's own pixels (a 4K screen at 150 % then draws 1.5× the 1080p pixels) */
    output: number;
    /** ChroViewer's quality: the floor mirror's reflection, "high" (2048 px, smoothed) / "medium" (1024) / "low" (512,
     *  fewer things reflected) / "none" (off); and its screen distortion effects (heat-haze style walls/notes) */
    quality: "high" | "medium" | "low" | "none"; distortion: boolean };
}

/**
 * What can be staged: the scene and the values typed in the panel. Match data, the replay playlist (it runs on a
 * live clock) and the technical settings (video links, stream delay, replay quality) are never staged.
 */
export interface StagedShow {
  scene: string; header: string; upNext: ShowState["upNext"]; brb: ShowState["brb"]; casters: Caster[];
  castersFrom: ShowState["castersFrom"]; ticker: string[];
  brbMinutes?: number;                    // "back in N min" was staged: the countdown starts when it goes live
  airScene: string;                       // the on-air scene when staging began (to tell that air has moved since)
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
  | "matchStart" | "mapPick" | "mapBan" | "picksDone" | "mapNext" | "mapLoad" | "mapStart" | "songEnd" | "mapEnd" | "matchEnd"
  | "replay" | "timeout";

export interface EventMsg {
  name: OverlayEvent;
  item?: number;          // pool index for mapPick/mapBan
  side?: Side;
}

export interface DataSource {
  readonly name: string;
  /** `live`: a source that knows the live gameplay itself (BSCompStats in TA mode) reports it here; null = over. */
  start(emit: (data: OverlayData) => void, event: (e: EventMsg) => void, live?: (state: LiveState | null) => void): Promise<void>;
  stop(): Promise<void>;
  /** Source-specific controls (the simulator's buttons). */
  control?(action: string, args: Record<string, unknown>): Promise<void> | void;
  status(): string;
}

/** The accuracy lead that puts the "who is winning" bar (`tug`) at its end: 10 percentage points. */
export const TUG_FULL = 0.10;

export const blankSide = (): SideData => ({
  name: "TBD", players: [], roster: [], avatar: "", logoKind: "star", logo: "", replays: [], initials: "?", country: "", seed: null, points: 0,
  matchPoints: null, score: 0, acc: null, combo: 0, maxCombo: 0, misses: 0, health: 0.5, finished: false, leading: false, winner: false,
});

/** BSCompStats' match points curve (packages/core/src/match/points.ts there; keep the two the same). */
export const rawCurve = (acc: number, c: { padding: number; slope: number }) => {
  const a = Math.min(1, Math.max(0, acc));
  return 1 / (1 + c.padding - a) + c.slope * a;
};
/** The curve run backwards: the accuracy whose curve value is `raw` (1 where not even 100% reaches it). */
export function accuracyForRaw(raw: number, c: { padding: number; slope: number }): number {
  if (!Number.isFinite(raw) || raw > rawCurve(1, c)) return 1;
  if (raw <= rawCurve(0, c)) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (rawCurve(mid, c) < raw) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
