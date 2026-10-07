import { run, one, now, emit } from "./store.mjs";

// Running a duck's command so a person can watch it happen.
//
// The provider's command endpoint is one blocking call: it answers when the
// command has finished and not before, so nothing about a command that takes
// forty seconds is knowable for forty seconds. Somebody watching their duck saw
// a motionless screen and a chat that said "Working", and the whole of the work
// arrived at the end or not at all.
//
// So the command is started in the background on the box with its output
// redirected to files, and read back as it grows. What arrives is appended to a
// row the terminal panel in chat is already reading.
//
// The duck's contract does not change. It still makes one call and still gets
// one complete result, with stdout and stderr separate - which is why there are
// two files and not one, merged with 2>&1, which would have quietly turned two
// fields the duck reads differently into one.
//
// It also holds the per-computer lock for a moment instead of for the length of
// the command. That is what used to make a long command block somebody trying
// to take the screen, and freeze the very preview they were taking it to look
// at.

// What has arrived so far, for the panel to show while it is still arriving.
export const outputSoFar = (actionId) =>
  one("SELECT stdout,stderr FROM terminal_output WHERE action_id=?", actionId);

const dir = "/tmp/tameduck-terminal";
// Long and strange enough that no line a duck writes is one of them. The first
// is a heredoc terminator, the others separate three answers in one reply.
const FENCE = "TAMEDUCK_a4f1c9_END";
const OUT = "--TD-a4f1c9-OUT--",
  ERR = "--TD-a4f1c9-ERR--",
  CODE = "--TD-a4f1c9-CODE--";
// Where stdout and stderr were already capped, so the duck is handed what it
// always was. The file is read past these so the truncation flags stay honest,
// but only this much is kept anywhere.
const OUT_CAP = 20000,
  ERR_CAP = 10000;

// The command is written to a file rather than quoted into a shell line: a
// heredoc with a quoted terminator passes it through exactly as the duck wrote
// it, quotes and all. setsid and </dev/null are what let the work outlive this
// call; the exit code is written last, so its existence means everything else
// is already on disk.
const startScript = (op, command) =>
  `mkdir -p ${dir} && rm -f ${dir}/${op}.* && cat > ${dir}/${op}.sh <<'${FENCE}'\n` +
  command +
  `\n${FENCE}\n` +
  `setsid sh -c 'sh ${dir}/${op}.sh > ${dir}/${op}.out 2> ${dir}/${op}.err;` +
  ` echo $? > ${dir}/${op}.code' < /dev/null > /dev/null 2>&1 &\n` +
  `echo $! > ${dir}/${op}.pid\n` +
  `echo started`;

// One read of both streams and the exit code. tail -c +N is 1-based, so the
// offset is the count of bytes already seen plus one.
const readScript = (op, outAt, errAt) =>
  `printf '%s' '${OUT}'; tail -c +${outAt + 1} ${dir}/${op}.out 2>/dev/null;` +
  ` printf '%s' '${ERR}'; tail -c +${errAt + 1} ${dir}/${op}.err 2>/dev/null;` +
  ` printf '%s' '${CODE}'; cat ${dir}/${op}.code 2>/dev/null`;

// Stop a command that has outstayed its welcome, rather than only stopping
// watching it. setsid made it a process group of its own, so this reaches the
// whole of it and not just the shell that started it.
const killScript = (op) =>
  `p=$(cat ${dir}/${op}.pid 2>/dev/null); [ -n "$p" ] && kill -TERM -"$p" 2>/dev/null;` +
  ` sleep 1; [ -n "$p" ] && kill -KILL -"$p" 2>/dev/null; rm -f ${dir}/${op}.*; echo stopped`;

function parse(text) {
  const body = String(text || "");
  const o = body.indexOf(OUT),
    e = body.indexOf(ERR, o + 1),
    c = body.indexOf(CODE, e + 1);
  if (o < 0 || e < 0 || c < 0) return null;
  const code = body.slice(c + CODE.length).trim();
  return {
    out: body.slice(o + OUT.length, e),
    err: body.slice(e + ERR.length, c),
    code: /^-?\d+$/.test(code) ? Number(code) : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `send(command, timeoutSeconds)` runs one command on the box and resolves to
// the provider's result. `alive()` throws if the run has been stopped, so a
// cancelled run stops watching instead of holding on to something nobody is
// waiting for. `onPoll()` is the caller's chance to keep the machine's own
// bookkeeping fresh while the lock is not held.
export async function runStreaming(
  { op, command, timeoutSeconds, companyId },
  { send, alive = () => {}, onPoll = async () => {}, pauseMs = 250 },
) {
  run("INSERT OR REPLACE INTO terminal_output VALUES(?,'','',?)", op, now());
  await send(startScript(op, command), 20);
  let out = "",
    err = "",
    outAt = 0,
    errAt = 0,
    code = null,
    ended = false;
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    while (true) {
      alive();
      let chunk = null;
      try {
        chunk = parse((await send(readScript(op, outAt, errAt), 20)).stdout);
      } catch {
        // One read that did not come back is not the end of the command. The next
        // one is a couple of seconds away, and the deadline below is what ends
        // this if they keep failing.
        chunk = null;
      }
      if (chunk) {
        outAt += Buffer.byteLength(chunk.out);
        errAt += Buffer.byteLength(chunk.err);
        if (chunk.out || chunk.err) {
          out = (out + chunk.out).slice(0, OUT_CAP + 1);
          err = (err + chunk.err).slice(0, ERR_CAP + 1);
          run(
            "UPDATE terminal_output SET stdout=?,stderr=?,updated=? WHERE action_id=?",
            out.slice(0, OUT_CAP),
            err.slice(0, ERR_CAP),
            now(),
            op,
          );
          // Only when something actually arrived: a read that found nothing new
          // must not wake every open tab in the company.
          emit(companyId);
        }
        if (chunk.code !== null) {
          code = chunk.code;
          ended = true;
        }
      }
      if (ended) break;
      if (Date.now() >= deadline) break;
      await onPoll().catch(() => {});
      // A round trip to the box is itself two to four seconds, so this is a
      // breath between reads rather than the interval: the interval is the
      // journey.
      await sleep(pauseMs);
    }
  } finally {
    // Whatever happened, nothing is left running and nothing is left on the
    // disk of a machine that may live for hours.
    //
    // The finally is the point. alive() throws inside the loop the moment a
    // person takes the screen or presses Stop, and that leapt straight past
    // this: the command went on running on the box, writing to files nobody
    // would ever delete, while the chat showed a frozen panel and the duck was
    // told its run had stopped. If the duck then picked the task up again it
    // started a second copy of the same work alongside the first.
    await send(killScript(op), 15).catch(() => {});
  }
  return {
    stdout: out.slice(0, OUT_CAP),
    stderr: err.slice(0, ERR_CAP),
    exitCode: ended ? code : null,
    // What the provider's own reply called success, worked out from the thing
    // that decides it, so the caller's reading of the result is unchanged.
    success: ended && code === 0,
    timedOut: !ended,
    stdoutTruncated: outAt > OUT_CAP,
    stderrTruncated: errAt > ERR_CAP,
  };
}
// Output belonging to runs long finished. The panel only ever looks at the
// recent end of a transcript.
export const forgetTerminalOutput = (before) =>
  run("DELETE FROM terminal_output WHERE updated<?", before);
export const terminalStreamInternals = {
  startScript,
  readScript,
  killScript,
  parse,
  dir,
};
