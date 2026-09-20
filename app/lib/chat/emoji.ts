/**
 * A hand-curated emoji set (no dependency allowed for this). Enough for a
 * team chat: Slack's default quick reactions, faces, hands, hearts, objects
 * and symbols people actually use, each with `:shortcode:` aliases for the
 * composer's `:` autocomplete.
 */

export interface Emoji {
  char: string;
  /** Primary shortcode without colons. */
  name: string;
  /** Extra search terms and aliases. */
  keywords: readonly string[];
  group: EmojiGroup;
}

export type EmojiGroup = "smileys" | "people" | "hearts" | "objects" | "symbols" | "nature" | "food";

export const EMOJI_GROUPS: readonly { id: EmojiGroup; label: string }[] = [
  { id: "smileys", label: "Smileys" },
  { id: "people", label: "People" },
  { id: "hearts", label: "Hearts" },
  { id: "nature", label: "Nature" },
  { id: "food", label: "Food" },
  { id: "objects", label: "Objects" },
  { id: "symbols", label: "Symbols" },
];

/** The reaction bar's first row: Slack's stock set. */
export const QUICK_REACTIONS = ["👍", "✅", "👀", "🙌", "❤️", "😂", "🎉", "🙏"] as const;

const e = (char: string, name: string, group: EmojiGroup, ...keywords: string[]): Emoji => ({ char, name, keywords, group });

export const EMOJI: readonly Emoji[] = [
  // smileys
  e("😀", "grinning", "smileys", "smile", "happy"),
  e("😃", "smiley", "smileys", "happy"),
  e("😄", "smile", "smileys", "happy", "laugh"),
  e("😁", "grin", "smileys"),
  e("😆", "laughing", "smileys", "satisfied", "haha"),
  e("😅", "sweat_smile", "smileys", "phew"),
  e("🤣", "rofl", "smileys", "rolling", "laugh"),
  e("😂", "joy", "smileys", "tears", "laugh", "lol"),
  e("🙂", "slightly_smiling_face", "smileys"),
  e("🙃", "upside_down_face", "smileys"),
  e("😉", "wink", "smileys"),
  e("😊", "blush", "smileys", "happy"),
  e("😇", "innocent", "smileys", "angel"),
  e("🥰", "smiling_face_with_three_hearts", "smileys", "love"),
  e("😍", "heart_eyes", "smileys", "love"),
  e("🤩", "star_struck", "smileys", "wow"),
  e("😘", "kissing_heart", "smileys", "kiss"),
  e("😋", "yum", "smileys", "tasty"),
  e("😛", "stuck_out_tongue", "smileys"),
  e("😜", "stuck_out_tongue_winking_eye", "smileys"),
  e("🤪", "zany_face", "smileys", "crazy"),
  e("🤑", "money_mouth_face", "smileys", "rich"),
  e("🤗", "hugs", "smileys", "hug"),
  e("🤭", "hand_over_mouth", "smileys", "oops"),
  e("🤫", "shushing_face", "smileys", "quiet"),
  e("🤔", "thinking", "smileys", "hmm", "think"),
  e("🤐", "zipper_mouth_face", "smileys", "secret"),
  e("😐", "neutral_face", "smileys", "meh"),
  e("😑", "expressionless", "smileys"),
  e("😶", "no_mouth", "smileys", "silent"),
  e("😏", "smirk", "smileys"),
  e("😒", "unamused", "smileys"),
  e("🙄", "roll_eyes", "smileys", "eyeroll"),
  e("😬", "grimacing", "smileys", "awkward"),
  e("🤥", "lying_face", "smileys"),
  e("😌", "relieved", "smileys"),
  e("😔", "pensive", "smileys", "sad"),
  e("😪", "sleepy", "smileys", "tired"),
  e("😴", "sleeping", "smileys", "zzz"),
  e("😷", "mask", "smileys", "sick"),
  e("🤒", "face_with_thermometer", "smileys", "sick"),
  e("🤯", "exploding_head", "smileys", "mind blown"),
  e("🥳", "partying_face", "smileys", "party", "celebrate"),
  e("😎", "sunglasses", "smileys", "cool"),
  e("🤓", "nerd_face", "smileys", "geek"),
  e("🧐", "monocle_face", "smileys"),
  e("😕", "confused", "smileys"),
  e("😟", "worried", "smileys"),
  e("😮", "open_mouth", "smileys", "surprised"),
  e("😲", "astonished", "smileys", "shocked"),
  e("😳", "flushed", "smileys", "embarrassed"),
  e("🥺", "pleading_face", "smileys", "please"),
  e("😢", "cry", "smileys", "sad", "tear"),
  e("😭", "sob", "smileys", "cry"),
  e("😱", "scream", "smileys", "fear"),
  e("😤", "triumph", "smileys", "huff"),
  e("😡", "rage", "smileys", "angry", "mad"),
  e("🤬", "cursing_face", "smileys", "swear"),
  e("💀", "skull", "smileys", "dead"),
  e("💩", "poop", "smileys", "hankey"),
  e("🤡", "clown_face", "smileys"),
  e("👻", "ghost", "smileys", "boo"),
  e("👽", "alien", "smileys"),
  e("🤖", "robot", "smileys", "bot"),
  e("😺", "smiley_cat", "smileys", "cat"),
  // people / hands
  e("👍", "+1", "people", "thumbsup", "yes", "ok", "like"),
  e("👎", "-1", "people", "thumbsdown", "no", "dislike"),
  e("👋", "wave", "people", "hello", "bye", "hi"),
  e("🙌", "raised_hands", "people", "hooray", "praise"),
  e("👏", "clap", "people", "applause", "bravo"),
  e("🙏", "pray", "people", "thanks", "please"),
  e("🤝", "handshake", "people", "deal"),
  e("👌", "ok_hand", "people", "ok", "perfect"),
  e("✌️", "v", "people", "peace", "victory"),
  e("🤞", "crossed_fingers", "people", "luck"),
  e("🤟", "love_you_gesture", "people"),
  e("🤘", "metal", "people", "rock"),
  e("🤙", "call_me_hand", "people"),
  e("👈", "point_left", "people"),
  e("👉", "point_right", "people"),
  e("👆", "point_up_2", "people"),
  e("👇", "point_down", "people"),
  e("☝️", "point_up", "people"),
  e("✋", "raised_hand", "people", "stop", "high five"),
  e("🖐️", "raised_hand_with_fingers_splayed", "people"),
  e("💪", "muscle", "people", "strong", "flex"),
  e("🫡", "saluting_face", "people", "salute", "yes sir"),
  e("🤦", "facepalm", "people", "oops"),
  e("🤷", "shrug", "people", "dunno"),
  e("🧠", "brain", "people", "smart"),
  e("👀", "eyes", "people", "look", "watching"),
  e("👁️", "eye", "people"),
  e("💅", "nail_care", "people"),
  e("🕺", "man_dancing", "people", "dance"),
  e("💃", "dancer", "people", "dance"),
  e("🏃", "runner", "people", "run"),
  e("🧑‍💻", "technologist", "people", "coder", "developer"),
  // hearts
  e("❤️", "heart", "hearts", "love", "red"),
  e("🧡", "orange_heart", "hearts"),
  e("💛", "yellow_heart", "hearts"),
  e("💚", "green_heart", "hearts"),
  e("💙", "blue_heart", "hearts"),
  e("💜", "purple_heart", "hearts"),
  e("🖤", "black_heart", "hearts"),
  e("🤍", "white_heart", "hearts"),
  e("💔", "broken_heart", "hearts", "sad"),
  e("💕", "two_hearts", "hearts"),
  e("💖", "sparkling_heart", "hearts"),
  e("💗", "heartpulse", "hearts"),
  e("💯", "100", "hearts", "hundred", "perfect"),
  // nature
  e("🔥", "fire", "nature", "hot", "lit"),
  e("⭐", "star", "nature"),
  e("🌟", "star2", "nature", "sparkle"),
  e("✨", "sparkles", "nature", "shiny", "new"),
  e("⚡", "zap", "nature", "lightning", "fast"),
  e("☀️", "sunny", "nature", "sun"),
  e("🌈", "rainbow", "nature"),
  e("☁️", "cloud", "nature"),
  e("🌧️", "cloud_with_rain", "nature", "rain"),
  e("❄️", "snowflake", "nature", "cold"),
  e("🌊", "ocean", "nature", "wave", "water"),
  e("🌱", "seedling", "nature", "plant", "grow"),
  e("🌲", "evergreen_tree", "nature", "tree"),
  e("🌸", "cherry_blossom", "nature", "flower"),
  e("🌹", "rose", "nature", "flower"),
  e("🍀", "four_leaf_clover", "nature", "luck"),
  e("🐶", "dog", "nature", "puppy"),
  e("🐱", "cat", "nature", "kitten"),
  e("🦊", "fox_face", "nature", "fox"),
  e("🐻", "bear", "nature"),
  e("🐼", "panda_face", "nature", "panda"),
  e("🐨", "koala", "nature"),
  e("🦁", "lion", "nature"),
  e("🐸", "frog", "nature"),
  e("🐢", "turtle", "nature", "slow"),
  e("🐙", "octopus", "nature"),
  e("🦄", "unicorn", "nature"),
  e("🐝", "bee", "nature", "honeybee"),
  e("🦋", "butterfly", "nature"),
  e("🐌", "snail", "nature", "slow"),
  e("🐛", "bug", "nature", "insect"),
  e("🦀", "crab", "nature", "rust"),
  // food
  e("☕", "coffee", "food", "cafe"),
  e("🍵", "tea", "food"),
  e("🍺", "beer", "food", "drink"),
  e("🍻", "beers", "food", "cheers"),
  e("🥂", "champagne", "food", "cheers", "toast"),
  e("🍷", "wine_glass", "food", "wine"),
  e("🍕", "pizza", "food"),
  e("🍔", "hamburger", "food", "burger"),
  e("🌮", "taco", "food"),
  e("🍣", "sushi", "food"),
  e("🍩", "doughnut", "food", "donut"),
  e("🍪", "cookie", "food"),
  e("🎂", "birthday", "food", "cake"),
  e("🍰", "cake", "food"),
  e("🍎", "apple", "food"),
  e("🍌", "banana", "food"),
  e("🥑", "avocado", "food"),
  e("🍿", "popcorn", "food"),
  // objects
  e("🎉", "tada", "objects", "party", "celebrate", "congrats"),
  e("🎊", "confetti_ball", "objects", "party"),
  e("🎈", "balloon", "objects", "party"),
  e("🎁", "gift", "objects", "present"),
  e("🏆", "trophy", "objects", "win", "award"),
  e("🥇", "1st_place_medal", "objects", "gold", "first"),
  e("🚀", "rocket", "objects", "ship", "launch", "deploy"),
  e("🛠️", "hammer_and_wrench", "objects", "tools", "fix"),
  e("🔧", "wrench", "objects", "fix"),
  e("🔨", "hammer", "objects"),
  e("⚙️", "gear", "objects", "settings"),
  e("🔒", "lock", "objects", "secure", "private"),
  e("🔓", "unlock", "objects", "open"),
  e("🔑", "key", "objects", "password"),
  e("💡", "bulb", "objects", "idea", "light"),
  e("🔔", "bell", "objects", "notification"),
  e("🔕", "no_bell", "objects", "mute"),
  e("📌", "pushpin", "objects", "pin"),
  e("📎", "paperclip", "objects", "attach"),
  e("📝", "memo", "objects", "note", "pencil"),
  e("📅", "date", "objects", "calendar"),
  e("📆", "calendar", "objects"),
  e("⏰", "alarm_clock", "objects", "time", "reminder"),
  e("⏳", "hourglass_flowing_sand", "objects", "wait", "loading"),
  e("💻", "computer", "objects", "laptop"),
  e("🖥️", "desktop_computer", "objects"),
  e("📱", "iphone", "objects", "phone", "mobile"),
  e("🔋", "battery", "objects"),
  e("💾", "floppy_disk", "objects", "save", "storage"),
  e("📦", "package", "objects", "box", "release"),
  e("📁", "file_folder", "objects", "folder"),
  e("📊", "bar_chart", "objects", "chart", "stats"),
  e("📈", "chart_with_upwards_trend", "objects", "growth", "up"),
  e("📉", "chart_with_downwards_trend", "objects", "down"),
  e("🔍", "mag", "objects", "search"),
  e("🔗", "link", "objects", "url"),
  e("🧪", "test_tube", "objects", "test", "experiment"),
  e("🐞", "lady_beetle", "objects", "bug", "ladybug"),
  e("🎯", "dart", "objects", "target", "goal"),
  e("🎮", "video_game", "objects", "gaming"),
  e("🎵", "musical_note", "objects", "music"),
  e("🎧", "headphones", "objects", "music"),
  e("📣", "mega", "objects", "announce", "megaphone"),
  e("💬", "speech_balloon", "objects", "chat", "comment"),
  e("🗑️", "wastebasket", "objects", "trash", "delete"),
  e("🧹", "broom", "objects", "clean", "sweep"),
  e("🚧", "construction", "objects", "wip", "work in progress"),
  e("🚨", "rotating_light", "objects", "alert", "urgent"),
  e("🏁", "checkered_flag", "objects", "finish", "done"),
  e("🎓", "mortar_board", "objects", "graduate", "learn"),
  e("💰", "moneybag", "objects", "money", "cash"),
  e("💸", "money_with_wings", "objects", "spend"),
  e("🧊", "ice_cube", "objects", "cold", "chill"),
  e("🍾", "bottle_with_popping_cork", "objects", "celebrate"),
  // symbols
  e("✅", "white_check_mark", "symbols", "check", "done", "yes", "approved"),
  e("☑️", "ballot_box_with_check", "symbols", "check"),
  e("✔️", "heavy_check_mark", "symbols", "check"),
  e("❌", "x", "symbols", "no", "cross", "wrong"),
  e("❎", "negative_squared_cross_mark", "symbols"),
  e("⭕", "o", "symbols", "circle"),
  e("❗", "exclamation", "symbols", "important"),
  e("❓", "question", "symbols", "help"),
  e("⚠️", "warning", "symbols", "caution"),
  e("🚫", "no_entry_sign", "symbols", "forbidden", "blocked"),
  e("♻️", "recycle", "symbols"),
  e("➕", "heavy_plus_sign", "symbols", "plus", "add"),
  e("➖", "heavy_minus_sign", "symbols", "minus"),
  e("➡️", "arrow_right", "symbols", "next"),
  e("⬅️", "arrow_left", "symbols", "back"),
  e("⬆️", "arrow_up", "symbols", "up"),
  e("⬇️", "arrow_down", "symbols", "down"),
  e("🔄", "arrows_counterclockwise", "symbols", "refresh", "sync", "retry"),
  e("🔁", "repeat", "symbols", "loop"),
  e("▶️", "arrow_forward", "symbols", "play"),
  e("⏸️", "pause_button", "symbols", "pause"),
  e("⏹️", "stop_button", "symbols", "stop"),
  e("🆗", "ok", "symbols"),
  e("🆕", "new", "symbols"),
  e("🆙", "up", "symbols"),
  e("🔞", "underage", "symbols"),
  e("♾️", "infinity", "symbols", "forever"),
  e("🟢", "green_circle", "symbols", "online", "go"),
  e("🟡", "yellow_circle", "symbols", "away", "pending"),
  e("🔴", "red_circle", "symbols", "busy", "live", "stop"),
  e("⚫", "black_circle", "symbols", "offline"),
  e("🟦", "blue_square", "symbols"),
  e("💤", "zzz", "symbols", "sleep", "afk"),
  e("🔅", "low_brightness", "symbols"),
  e("™️", "tm", "symbols", "trademark"),
  e("©️", "copyright", "symbols"),
  e("#️⃣", "hash", "symbols", "number"),
];

const BY_NAME = new Map<string, Emoji>();
for (const item of EMOJI) {
  BY_NAME.set(item.name, item);
  for (const alias of item.keywords) if (!BY_NAME.has(alias)) BY_NAME.set(alias, item);
}

/** `:shortcode:` -> emoji char, or `null`. Accepts with or without colons. */
export function emojiForShortcode(code: string): string | null {
  const key = code.replace(/^:|:$/g, "").toLowerCase();
  return BY_NAME.get(key)?.char ?? null;
}

/** Prefix + keyword search; primary-name prefix matches first, then keyword hits. */
export function searchEmoji(query: string, limit = 24): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:/, "");
  if (!q) return EMOJI.slice(0, limit);
  const prefix: Emoji[] = [];
  const keyword: Emoji[] = [];
  for (const item of EMOJI) {
    if (item.name.startsWith(q)) prefix.push(item);
    else if (item.name.includes(q) || item.keywords.some((k) => k.startsWith(q) || k.includes(q))) keyword.push(item);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...keyword].slice(0, limit);
}

/** Replace `:shortcode:` tokens in a message with their emoji. */
export function replaceShortcodes(text: string): string {
  return text.replace(/(^|\s):([a-z0-9_+-]+):(?=\s|$|[.,!?])/gi, (match, lead: string, code: string) => {
    const emoji = emojiForShortcode(code);
    return emoji ? `${lead}${emoji}` : match;
  });
}

/** Strings made only of emoji (and whitespace), up to three, render large. */
export function isEmojiOnly(text: string, maxCount = 3): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const chars = [...trimmed.replace(/\s+/g, "")];
  if (chars.length === 0) return false;
  const emojiRe = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u;
  if (!emojiRe.test(chars.join(""))) return false;
  // Count grapheme-ish units: each extended pictographic starts a new unit.
  let count = 0;
  for (const ch of chars) if (/\p{Extended_Pictographic}/u.test(ch)) count++;
  return count > 0 && count <= maxCount;
}
