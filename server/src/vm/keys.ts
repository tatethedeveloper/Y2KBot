// Map text and key combos to QEMU qcodes.

const NAMED: Record<string, string> = {
  enter: "ret", return: "ret", ret: "ret",
  esc: "esc", escape: "esc",
  tab: "tab", space: "spc", spc: "spc",
  backspace: "backspace", bksp: "backspace",
  delete: "delete", del: "delete", insert: "insert", ins: "insert",
  home: "home", end: "end", pageup: "pgup", pgup: "pgup", pagedown: "pgdn", pgdn: "pgdn",
  up: "up", down: "down", left: "left", right: "right",
  ctrl: "ctrl", control: "ctrl", alt: "alt", shift: "shift",
  win: "meta_l", windows: "meta_l", super: "meta_l", meta: "meta_l", cmd: "meta_l",
  menu: "menu", printscreen: "print", print: "print", capslock: "caps_lock",
  "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right",
  ";": "semicolon", "'": "apostrophe", "`": "grave_accent", "\\": "backslash",
  ",": "comma", ".": "dot", "/": "slash",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = `f${i}`;

const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right", ":": "semicolon",
  '"': "apostrophe", "~": "grave_accent", "|": "backslash", "<": "comma", ">": "dot", "?": "slash",
};

/** Returns the qcodes to hold down together to produce `ch`, or null if untypeable. */
export function charToQcodes(ch: string): string[] | null {
  if (ch === "\n") return ["ret"];
  if (ch === "\t") return ["tab"];
  if (ch === " ") return ["spc"];
  if (/^[a-z0-9]$/.test(ch)) return [ch];
  if (/^[A-Z]$/.test(ch)) return ["shift", ch.toLowerCase()];
  if (SHIFTED[ch]) return ["shift", SHIFTED[ch]];
  if (NAMED[ch]) return [NAMED[ch]];
  return null;
}

/** "ctrl+alt+delete", "win+r", "enter", "F4" → qcodes */
export function comboToQcodes(combo: string): string[] {
  return combo
    .toLowerCase()
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      if (NAMED[k]) return NAMED[k];
      if (/^[a-z0-9]$/.test(k)) return k;
      throw new Error(`Unknown key "${k}" in combo "${combo}"`);
    });
}
