import crypto from "node:crypto";
import path from "node:path";

export const MAX_COMPUTER_IMPORT_BYTES = 25 * 1000 * 1000;
// Linux limits each individual command argument to about 128 KiB. Base64 adds
// a third, so keep each private payload comfortably below that limit.
const CHUNK_BYTES = 64 * 1024;

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const python = (script, args) =>
  "python3 -c " + quote(script) + " " + args.map(quote).join(" ");
const providerFailure = () =>
  Object.assign(
    new Error("The file could not be transferred to the computer."),
    { status: 502 },
  );

// The scripts open the private tree one component at a time. A symlink cannot
// substitute for the home, application or imports directory, and file names
// are always resolved relative to the already-open imports directory.
const commonPython = String.raw`
import json,os,stat,sys
requested_home,name,total,digest=sys.argv[1],sys.argv[2],int(sys.argv[3]),sys.argv[4]
home=os.path.abspath(requested_home or os.path.expanduser("~"))
if home=="/" or not os.path.isabs(home): raise RuntimeError("unsafe home")
NOFOLLOW=getattr(os,"O_NOFOLLOW",0)
DIRFLAGS=os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW
uid=os.geteuid()
def owned_dir(fd):
  s=os.fstat(fd)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise RuntimeError("unsafe directory")
def private_child(parent,name):
  try: os.mkdir(name,0o700,dir_fd=parent)
  except FileExistsError: pass
  fd=os.open(name,DIRFLAGS,dir_fd=parent)
  owned_dir(fd)
  os.fchmod(fd,0o700)
  return fd
h=os.open(home,DIRFLAGS); owned_dir(h)
t=private_child(h,"tameduck"); os.close(h)
d=private_child(t,"imports"); os.close(t)
part="."+name+".part"
def opened(filename,flags=os.O_RDONLY):
  fd=os.open(filename,flags|NOFOLLOW,dir_fd=d)
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid: os.close(fd); raise RuntimeError("unsafe file")
  return fd,s
def hash_file(fd):
  import hashlib
  h=hashlib.sha256(); at=0
  while True:
    chunk=os.pread(fd,1024*1024,at)
    if not chunk: return h.hexdigest()
    h.update(chunk); at+=len(chunk)
def exact(filename,links=(1,)):
  fd,s=opened(filename)
  try: return s.st_nlink in links and stat.S_IMODE(s.st_mode)==0o600 and s.st_size==total and hash_file(fd)==digest
  finally: os.close(fd)
`;

const preparePython =
  commonPython +
  String.raw`
try:
  target_fd,target_stat=opened(name)
except FileNotFoundError:
  target_fd=target_stat=None
if target_fd is not None:
  os.close(target_fd)
  if target_stat.st_nlink==2:
    try:
      part_stat=os.stat(part,dir_fd=d,follow_symlinks=False)
      if not stat.S_ISREG(part_stat.st_mode) or part_stat.st_uid!=uid or (part_stat.st_dev,part_stat.st_ino)!=(target_stat.st_dev,target_stat.st_ino): raise RuntimeError("unsafe linked file")
      os.unlink(part,dir_fd=d)
    except FileNotFoundError: raise RuntimeError("unexpected hard link")
  target_fd,target_stat=opened(name,os.O_RDWR)
  os.fchmod(target_fd,0o600); os.fsync(target_fd); os.close(target_fd)
  if not exact(name): raise RuntimeError("destination exists")
  print(json.dumps({"state":"complete","home":home}))
else:
  try: fd=os.open(part,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600,dir_fd=d)
  except FileExistsError: fd,s=opened(part,os.O_WRONLY)
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1 or s.st_size>total: os.close(fd); raise RuntimeError("unsafe partial")
  os.fchmod(fd,0o600); os.close(fd)
  print(json.dumps({"state":"upload","offset":s.st_size,"home":home}))
`;

const chunkPython =
  commonPython +
  String.raw`
import base64
offset=int(sys.argv[5]); data=base64.b64decode(sys.argv[6],validate=True)
if offset<0 or offset+len(data)>total: raise RuntimeError("invalid chunk")
fd,s=opened(part,os.O_RDWR)
try:
  if s.st_nlink!=1 or s.st_size>total: raise RuntimeError("unsafe partial")
  if s.st_size<offset: raise RuntimeError("chunk gap")
  if s.st_size>=offset+len(data):
    if os.pread(fd,len(data),offset)!=data: raise RuntimeError("chunk conflict")
  else:
    present=max(0,s.st_size-offset)
    if present and os.pread(fd,present,offset)!=data[:present]: raise RuntimeError("partial conflict")
    if present: os.ftruncate(fd,offset)
    at=0
    while at<len(data):
      wrote=os.pwrite(fd,data[at:],offset+at)
      if wrote<=0: raise RuntimeError("short write")
      at+=wrote
    os.fsync(fd)
finally: os.close(fd)
print("chunk")
`;

const finishPython =
  commonPython +
  String.raw`
fd,s=opened(part,os.O_RDWR)
try:
  if s.st_nlink!=1 or s.st_size!=total or hash_file(fd)!=digest: raise RuntimeError("incomplete file")
  os.fchmod(fd,0o600); os.fsync(fd)
finally: os.close(fd)
try: os.link(part,name,src_dir_fd=d,dst_dir_fd=d,follow_symlinks=False)
except FileExistsError:
  if not exact(name): raise RuntimeError("destination exists")
else:
  if not exact(name,links=(2,)): raise RuntimeError("final verification failed")
os.unlink(part,dir_fd=d)
fd,s=opened(name)
try:
  if s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size!=total or hash_file(fd)!=digest: raise RuntimeError("final verification failed")
finally: os.close(fd); os.close(d)
print("complete")
`;

async function providerCommand(request, boxId, command, guard) {
  await guard();
  let result;
  try {
    result = await request(
      "/boxes/" + encodeURIComponent(boxId) + "/commands",
      "POST",
      { command, timeoutSeconds: 60 },
      { timeout: 67000, sensitive: true },
    );
  } catch {
    // Provider errors can contain echoed commands, stdout or stderr. None of
    // that crosses this boundary or reaches application logs.
    throw providerFailure();
  }
  if (!result?.success || result.exitCode !== 0 || result.timedOut)
    throw providerFailure();
  await guard();
  return String(result.stdout || "").trim();
}

export async function transferComputerFile(
  { request, boxId, file, guard = () => {} },
  { home = null } = {},
) {
  if (typeof request !== "function" || !boxId)
    fail(500, "Private file transfer is unavailable right now.");
  if (!file || !Buffer.isBuffer(file.bytes) || !Number.isInteger(file.size))
    fail(400, "Invalid computer file.");
  if (file.size < 0 || file.size > MAX_COMPUTER_IMPORT_BYTES)
    fail(413, "This file is too large for the computer.");
  if (file.bytes.length !== file.size)
    fail(400, "This file failed its integrity check.");
  const digest = crypto.createHash("sha256").update(file.bytes).digest("hex");
  if (digest !== file.sha256)
    fail(400, "This file failed its integrity check.");
  const name = String(file.name || "");
  if (
    name.length < 1 ||
    Buffer.byteLength(name) > 220 ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) ||
    name === "." ||
    name === ".."
  )
    fail(400, "This file needs a safe name.");
  if (
    home !== null &&
    (!path.posix.isAbsolute(home) || home === "/" || home.endsWith("/"))
  )
    fail(500, "Private file transfer is unavailable right now.");
  let baseArgs = [home || "", name, String(file.size), digest];
  const preparedText = await providerCommand(
    request,
    boxId,
    python(preparePython, baseArgs),
    guard,
  );
  let prepared;
  try {
    prepared = JSON.parse(preparedText);
  } catch {
    throw providerFailure();
  }
  const resolvedHome = String(prepared?.home || "");
  if (
    !path.posix.isAbsolute(resolvedHome) ||
    resolvedHome === "/" ||
    resolvedHome.endsWith("/") ||
    Buffer.byteLength(resolvedHome) > 1024 ||
    /[\x00-\x1f\x7f]/.test(resolvedHome) ||
    path.posix.normalize(resolvedHome) !== resolvedHome ||
    (home !== null && resolvedHome !== home)
  )
    throw providerFailure();
  baseArgs = [resolvedHome, name, String(file.size), digest];
  if (prepared.state !== "complete") {
    if (prepared.state !== "upload") throw providerFailure();
    const existing = prepared.offset;
    if (!Number.isSafeInteger(existing) || existing < 0 || existing > file.size)
      throw providerFailure();
    const first = Math.floor(existing / CHUNK_BYTES) * CHUNK_BYTES;
    for (let offset = first; offset < file.size; offset += CHUNK_BYTES) {
      const chunk = file.bytes.subarray(offset, offset + CHUNK_BYTES);
      const status = await providerCommand(
        request,
        boxId,
        python(chunkPython, [
          ...baseArgs,
          String(offset),
          chunk.toString("base64"),
        ]),
        guard,
      );
      if (status !== "chunk") throw providerFailure();
    }
    if (
      (await providerCommand(
        request,
        boxId,
        python(finishPython, baseArgs),
        guard,
      )) !== "complete"
    )
      throw providerFailure();
  }
  return {
    verified: true,
    path: path.posix.join(resolvedHome, "tameduck", "imports", name),
    size: file.size,
    sha256: digest,
  };
}

export const computerFileImportInternals = {
  CHUNK_BYTES,
  preparePython,
  chunkPython,
  finishPython,
};
