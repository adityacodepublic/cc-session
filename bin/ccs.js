#!/usr/bin/env node
// Keyboard session picker for Claude Code. Run it inside the project folder.
//   up/down/home/end move | Enter resume | n new | d, d delete | q quit

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// Same folder Claude uses: CLAUDE_CONFIG_DIR if set, else ~/.claude
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// Claude's folder name for a project: the working directory with every non-alphanumeric character
// turned into '-'. Over 200 characters, Claude cuts it and adds a hash; it finds such a folder again
// by its first 200 characters (case-insensitive), so we do the same.
const MAX_SLUG = 200;

function findProjectDir() {
  const projects = path.join(claudeDir, 'projects');
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) return path.join(projects, slug);
  const prefix = `${slug.slice(0, MAX_SLUG)}-`.toLowerCase();
  const found = fs.existsSync(projects) && fs.readdirSync(projects).find((d) => d.toLowerCase().startsWith(prefix));
  return path.join(projects, found || slug);
}

const projectDir = findProjectDir();

// Everything Claude keeps for one session.
const sessionPaths = (id) => [
  path.join(projectDir, `${id}.jsonl`),
  path.join(projectDir, id),
  path.join(claudeDir, 'session-env', id),
  path.join(claudeDir, 'file-history', id),
];

// ---- Which sessions /resume shows, and their titles ----
// Rules read from claude.exe 2.1.284 (its session-list code). Claude looks only at the first and last
// chunk of each file, so we do too.
const CHUNK = 64 * 1024;
const MESSAGE_MARK = '"parentUuid":'; // every real chat entry has it; title/cost lines do not
const SDK_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']); // claude -p and the SDK
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

const slugOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-').slice(0, MAX_SLUG);
const normalize = (p) => (CASE_INSENSITIVE_FS ? path.resolve(p).toLowerCase() : path.resolve(p));

// Values of a JSON string field ("key":"value") found in text, JSON-unescaped.
function values(text, key) {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  return [...text.matchAll(re)].map((m) => JSON.parse(`"${m[1]}"`));
}
const firstValue = (text, key) => values(text, key)[0];
const lastValue = (text, key) => values(text, key).at(-1);

function readChunks(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, CHUNK);
    const read = (position) => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, position);
      return buf.toString('utf8');
    };
    return { size, head: read(0), tail: read(size - len) };
  } finally {
    fs.closeSync(fd);
  }
}

// Rule 1: a file with no real chat entry is only title/cost bookkeeping.
function hasMessages(file, { size, head, tail }) {
  if (head.includes(MESSAGE_MARK) || tail.includes(MESSAGE_MARK)) return true;
  return size > CHUNK && fs.readFileSync(file, 'utf8').includes(MESSAGE_MARK);
}

// Rule 2: sub-agent transcript.
const isSidechain = (head) => /"isSidechain":\s*true/.test(head);

// Rule 3: started by `claude -p` or the SDK.
const isSdkSession = (head, tail) => SDK_ENTRYPOINTS.has(firstValue(head, 'entrypoint') ?? lastValue(tail, 'entrypoint'));

// Rule 4: the last "continued-in" line names a newer session. A chat message after it cancels it.
const isRealMessage = (o) =>
  o.type === 'assistant'
    ? !o.isApiErrorMessage && typeof o.message?.stop_reason === 'string'
    : !o.isMeta && (typeof o.message?.content === 'string' || o.message?.content?.some?.((b) => b.type === 'text'));

function continuedInSessionId(tail) {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const isContinuedIn = lines[i].includes('"type":"continued-in"');
    if (!isContinuedIn && !lines[i].includes('"type":"user"') && !lines[i].includes('"type":"assistant"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (isContinuedIn) return entry.continuedInSessionId || undefined;
      if (isRealMessage(entry)) return undefined;
    } catch {} // a line cut in half at the start of the tail
  }
}

function isSuperseded(tail) {
  const next = continuedInSessionId(tail);
  if (!next) return false;
  const nextFile = path.join(projectDir, `${next}.jsonl`);
  try {
    return hasMessages(nextFile, readChunks(nextFile));
  } catch {
    return false; // the newer session file is gone, so this one is still the latest
  }
}

// Rule 5: the folder name is lossy (my.app and my-app share one), so check the folder the session ran in.
function isFromOtherFolder(head) {
  const cwd = firstValue(head, 'cwd');
  return cwd !== undefined && normalize(cwd) !== normalize(process.cwd()) && slugOf(cwd) === slugOf(process.cwd());
}

// Title, like /resume: /rename title, then generated title, then the prompt, then "(session)".
function readCustomTitleFile(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, id, 'custom-title.json'), 'utf8')).customTitle || undefined;
  } catch {}
}

function firstUserPrompt(head) {
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true')) continue;
    try {
      const content = JSON.parse(line).message?.content;
      const text = (typeof content === 'string' ? content : content?.find?.((b) => b.type === 'text')?.text)?.trim();
      if (text && !text.startsWith('<')) return text;
    } catch {}
  }
}

const getTitle = (id, { head, tail }) =>
  lastValue(tail, 'customTitle') ??
  readCustomTitleFile(id) ??
  lastValue(head, 'customTitle') ??
  lastValue(tail, 'aiTitle') ??
  lastValue(head, 'aiTitle') ??
  (lastValue(tail, 'lastPrompt') || firstUserPrompt(head) || '(session)');

function getSessions() {
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => {
      const file = path.join(projectDir, f);
      const id = f.slice(0, -'.jsonl'.length);
      try {
        const chunks = readChunks(file);
        const hidden =
          !hasMessages(file, chunks) ||
          isSidechain(chunks.head) ||
          isSdkSession(chunks.head, chunks.tail) ||
          isSuperseded(chunks.tail) ||
          isFromOtherFolder(chunks.head);
        return hidden ? [] : [{ id, title: getTitle(id, chunks), mtime: fs.statSync(file).mtime }];
      } catch {
        return []; // unreadable file
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const formatTime = (d) => `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const CLEAR = '\x1b[2J\x1b[H';
// Alternate screen: the list draws on its own screen, so the shell output before it comes back on exit.
const ENTER_SCREEN = '\x1b[?1049h';
const LEAVE_SCREEN = '\x1b[?1049l';
const INVERSE = '\x1b[7m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const DATE_WIDTH = 12; // "29 Sep 15:10"

function render({ sessions, selected, top, armed }) {
  const cols = process.stdout.columns || 80;
  const titleWidth = Math.max(10, cols - DATE_WIDTH - 6);
  const lines = [`Claude sessions (${sessions.length})`, '↑↓ move   Enter resume   n new   d d delete   q quit', ''];

  for (let i = top; i < Math.min(sessions.length, top + visibleRows()); i++) {
    const s = sessions[i];
    const title = s.title.replace(/\s+/g, ' ');
    const shown = title.length > titleWidth ? `${title.slice(0, titleWidth - 1)}…` : title.padEnd(titleWidth);
    const row = `${i === selected ? '>' : ' '} ${shown}  ${formatTime(s.mtime)}`;
    lines.push(i === selected ? `${INVERSE}${row}${RESET}` : row);
  }

  if (armed) lines.push('', `${RED}Press d again to delete "${sessions[selected].title}" (any other key cancels)${RESET}`);
  process.stdout.write(CLEAR + lines.join('\n') + '\n');
}

// Rows left for the list after header (3 lines) and the delete prompt (2 lines).
const visibleRows = () => Math.max(3, (process.stdout.rows || 24) - 5);

function main() {
  const sessions = getSessions();
  if (sessions.length === 0) return console.log('No sessions found.');

  const state = { sessions, selected: 0, top: 0, armed: false };
  const stdin = process.stdin;

  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);

  const stop = () => {
    stdin.off('keypress', onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write(LEAVE_SCREEN);
  };

  function launchClaude(args = '') {
    stop();
    // shell:true so Windows finds claude.cmd; one command string avoids Node's args+shell warning
    spawn(`claude ${args}`, { stdio: 'inherit', shell: true }).on('exit', (code) => process.exit(code ?? 0));
  }

  function remove() {
    const [gone] = state.sessions.splice(state.selected, 1);
    for (const p of sessionPaths(gone.id)) fs.rmSync(p, { recursive: true, force: true });    if (state.sessions.length === 0) {
      stop();
      return console.log('All sessions deleted.');
    }
    state.selected = Math.min(state.selected, state.sessions.length - 1);
  }

  function onKey(str, key = {}) {
    const wasArmed = state.armed;
    state.armed = false;
    const last = state.sessions.length - 1;

    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      return stop();
    }
    if (key.name === 'up') state.selected = Math.max(0, state.selected - 1);
    else if (key.name === 'down') state.selected = Math.min(last, state.selected + 1);
    else if (key.name === 'home') state.selected = 0;
    else if (key.name === 'end') state.selected = last;
    else if (key.name === 'return' || key.name === 'enter') return launchClaude(`--resume "${state.sessions[state.selected].id}"`);
    else if (key.name === 'n') return launchClaude();
    else if (key.name === 'd') {
      if (wasArmed) {
        remove();
        if (state.sessions.length === 0) return;
      } else state.armed = true;
    }

    // keep the selected row inside the visible window
    state.top = Math.min(state.top, state.selected);
    if (state.selected >= state.top + visibleRows()) state.top = state.selected - visibleRows() + 1;
    render(state);
  }

  stdin.on('keypress', onKey);
  process.on('exit', () => process.stdout.write(LEAVE_SCREEN)); // also covers a crash
  process.stdout.write(ENTER_SCREEN);
  render(state);
}

main();
