import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";

export const MAX_COMPUTER_EXPORT_BYTES = 25 * 1000 * 1000;
const CHUNK_BYTES = 64 * 1024;

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const python = (script, args) =>
  "python3 -c " + quote(script) + " " + args.map(quote).join(" ");
const providerFailure = () =>
  Object.assign(new Error("The file could not be copied from the computer."), {
    status: 502,
  });

// The guest opens the home and every path component separately. A symlink can
// never redirect the read, and an imported private file cannot be selected for
// publication even through a symlink or hard link.
const commonPython = String.raw`
import hashlib,json,os,stat,sys
requested=sys.argv[1]
home=os.path.abspath(os.path.expanduser("~"))
if home=="/" or not os.path.isabs(home): raise RuntimeError("unsafe home")
if not os.path.isabs(requested) or os.path.normpath(requested)!=requested: raise RuntimeError("unsafe path")
try: relative=os.path.relpath(requested,home)
except ValueError: raise RuntimeError("outside home")
parts=relative.split(os.sep)
if relative in ("",".") or any(p in ("",".","..") for p in parts): raise RuntimeError("outside home")
if len(parts)<3 or parts[:2]!=["tameduck","outputs"]: raise RuntimeError("not publishable")
NOFOLLOW=getattr(os,"O_NOFOLLOW",0)
DIRFLAGS=os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW
uid=os.geteuid()
def owned_dir(fd):
  s=os.fstat(fd)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise RuntimeError("unsafe directory")
d=os.open(home,DIRFLAGS); owned_dir(d)
try:
  for component in parts[:-1]:
    n=os.open(component,DIRFLAGS,dir_fd=d); owned_dir(n); os.close(d); d=n
  fd=os.open(parts[-1],os.O_RDONLY|NOFOLLOW|getattr(os,"O_NONBLOCK",0),dir_fd=d)
finally:
  os.close(d)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1: os.close(fd); raise RuntimeError("unsafe file")
if s.st_size>${MAX_COMPUTER_EXPORT_BYTES}: os.close(fd); raise RuntimeError("too large")
token=[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
def same(expected):
  current=os.fstat(fd)
  return [str(current.st_dev),str(current.st_ino),str(current.st_size),str(current.st_mtime_ns),str(current.st_ctime_ns)]==expected and stat.S_ISREG(current.st_mode) and current.st_uid==uid and current.st_nlink==1
def digest():
  h=hashlib.sha256(); total=0; os.lseek(fd,0,os.SEEK_SET)
  while True:
    chunk=os.read(fd,1024*1024)
    if not chunk: return h.hexdigest()
    total+=len(chunk)
    if total>${MAX_COMPUTER_EXPORT_BYTES}: raise RuntimeError("too large")
    h.update(chunk)
`;

const preparePython =
  commonPython +
  String.raw`
try:
  result={"home":home,"path":requested,"name":parts[-1],"size":s.st_size,"sha256":digest(),"token":token}
  if not same(token): raise RuntimeError("file changed")
  print(json.dumps(result,separators=(",",":")))
finally: os.close(fd)
`;

const chunkPython =
  commonPython +
  String.raw`
import base64
try:
  expected=json.loads(sys.argv[2]); offset=int(sys.argv[3]); length=int(sys.argv[4])
  if not same(expected) or offset<0 or length<0 or length>${CHUNK_BYTES} or offset+length>s.st_size: raise RuntimeError("file changed")
  data=os.pread(fd,length,offset)
  if len(data)!=length or not same(expected): raise RuntimeError("file changed")
  print(base64.b64encode(data).decode("ascii"))
finally: os.close(fd)
`;

const finishPython =
  commonPython +
  String.raw`
try:
  expected=json.loads(sys.argv[2]); expected_digest=sys.argv[3]
  if not same(expected) or digest()!=expected_digest or not same(expected): raise RuntimeError("file changed")
  print("verified")
finally: os.close(fd)
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
    throw providerFailure();
  }
  if (!result?.success || result.exitCode !== 0 || result.timedOut)
    throw providerFailure();
  await guard();
  return String(result.stdout || "").trim();
}

export async function readComputerFile({
  request,
  boxId,
  filePath,
  guard = () => {},
}) {
  if (typeof request !== "function" || !boxId)
    fail(500, "Computer file export is unavailable right now.");
  const requested = String(filePath || "");
  if (
    !path.posix.isAbsolute(requested) ||
    requested === "/" ||
    path.posix.normalize(requested) !== requested ||
    Buffer.byteLength(requested) > 2048 ||
    /[\x00-\x1f\x7f]/.test(requested)
  )
    fail(
      400,
      "Choose an absolute, normalized file path inside your computer home folder.",
    );
  const preparedText = await providerCommand(
    request,
    boxId,
    python(preparePython, [requested]),
    guard,
  );
  let prepared;
  try {
    prepared = JSON.parse(preparedText);
  } catch {
    throw providerFailure();
  }
  if (
    prepared?.path !== requested ||
    !path.posix.isAbsolute(prepared.home) ||
    prepared.home === "/" ||
    path.posix.normalize(prepared.home) !== prepared.home ||
    path.posix.basename(requested) !== prepared.name ||
    !Number.isSafeInteger(prepared.size) ||
    prepared.size < 0 ||
    prepared.size > MAX_COMPUTER_EXPORT_BYTES ||
    !/^[a-f0-9]{64}$/.test(prepared.sha256) ||
    !Array.isArray(prepared.token) ||
    prepared.token.length !== 5 ||
    prepared.token.some((v) => typeof v !== "string" || !/^\d+$/.test(v))
  )
    throw providerFailure();
  const relative = path.posix.relative(prepared.home, requested);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative) ||
    !relative.startsWith("tameduck/outputs/")
  )
    throw providerFailure();
  const token = JSON.stringify(prepared.token);
  async function* chunks() {
    const digest = crypto.createHash("sha256");
    let received = 0;
    for (let offset = 0; offset < prepared.size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, prepared.size - offset);
      const encoded = await providerCommand(
        request,
        boxId,
        python(chunkPython, [requested, token, String(offset), String(length)]),
        guard,
      );
      let bytes;
      try {
        bytes = Buffer.from(encoded, "base64");
      } catch {
        throw providerFailure();
      }
      if (
        bytes.length !== length ||
        bytes.toString("base64").replace(/=+$/, "") !==
          encoded.replace(/=+$/, "")
      )
        throw providerFailure();
      received += bytes.length;
      digest.update(bytes);
      yield bytes;
    }
    if (
      received !== prepared.size ||
      digest.digest("hex") !== prepared.sha256 ||
      (await providerCommand(
        request,
        boxId,
        python(finishPython, [requested, token, prepared.sha256]),
        guard,
      )) !== "verified"
    )
      throw providerFailure();
  }
  return {
    verified: true,
    path: requested,
    output_directory: path.posix.join(prepared.home, "tameduck", "outputs"),
    source_token: prepared.token,
    name: prepared.name,
    size: prepared.size,
    sha256: prepared.sha256,
    stream: Readable.from(chunks()),
  };
}

// This is an authoritative inventory only when the entire bounded walk
// succeeds. A partial result must never be used to infer deletion.
const inventoryPython = String.raw`
import json,os,stat,sys
home=os.path.abspath(os.path.expanduser("~")); uid=os.geteuid()
if home=="/" or not os.path.isabs(home): raise RuntimeError("unsafe home")
NOFOLLOW=getattr(os,"O_NOFOLLOW",0); D=os.O_RDONLY|os.O_DIRECTORY|NOFOLLOW
def directory(fd):
 s=os.fstat(fd)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise RuntimeError("unsafe directory")
h=os.open(home,D); directory(h)
try:
 t=os.open("tameduck",D,dir_fd=h); directory(t)
 try:
  try: root=os.open("outputs",D,dir_fd=t)
  except FileNotFoundError:
   print(json.dumps({"files":[]})); sys.exit(0)
  directory(root)
 finally: os.close(t)
finally: os.close(h)
found=[]; count=0
def walk(fd,parts,depth):
 global count
 if depth>8: raise RuntimeError("scan depth")
 for name in os.listdir(fd):
  count+=1
  if count>10000: raise RuntimeError("scan limit")
  s=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if s.st_uid!=uid or stat.S_ISLNK(s.st_mode): raise RuntimeError("unsafe entry")
  if stat.S_ISDIR(s.st_mode):
   child=os.open(name,D,dir_fd=fd); directory(child)
   try: walk(child,parts+[name],depth+1)
   finally: os.close(child)
  elif stat.S_ISREG(s.st_mode):
   if s.st_nlink!=1: raise RuntimeError("unsafe file")
   found.append({"path":os.path.join(home,"tameduck","outputs",*parts,name),"token":[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]})
  else: raise RuntimeError("unsafe entry")
try: walk(root,[],0)
finally: os.close(root)
print(json.dumps({"files":found},separators=(",",":")))
`;

export async function scanComputerOutputs({
  request,
  boxId,
  guard = () => {},
}) {
  if (typeof request !== "function" || !boxId) throw providerFailure();
  const output = await providerCommand(
    request,
    boxId,
    python(inventoryPython, []),
    guard,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw providerFailure();
  }
  if (
    !Array.isArray(parsed?.files) ||
    parsed.files.length > 10000 ||
    parsed.files.some(
      (file) =>
        typeof file.path !== "string" ||
        !Array.isArray(file.token) ||
        file.token.length !== 5 ||
        file.token.some(
          (part) => typeof part !== "string" || !/^\d+$/.test(part),
        ),
    )
  )
    throw providerFailure();
  return parsed.files;
}

const inventoryTreePython = inventoryPython
  .replace("found=[]; count=0", "found=[]; directories=[]; count=0")
  .replace(
    " global count\n",
    " global count\n directories.append({'relative_path':'/'.join(parts),'token':[str(os.fstat(fd).st_dev),str(os.fstat(fd).st_ino)]})\n",
  )
  .replace(
    'print(json.dumps({"files":[]}))',
    'print(json.dumps({"files":[],"directories":[],"output_directory":os.path.join(home,"tameduck","outputs")}))',
  )
  .replace(
    'print(json.dumps({"files":found},separators=(",",":")))',
    'print(json.dumps({"files":found,"directories":directories,"output_directory":os.path.join(home,"tameduck","outputs")},separators=(",",":")))',
  );

export async function scanComputerOutputTree({
  request,
  boxId,
  guard = () => {},
}) {
  if (typeof request !== "function" || !boxId) throw providerFailure();
  const output = await providerCommand(
    request,
    boxId,
    python(inventoryTreePython, []),
    guard,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw providerFailure();
  }
  const root = parsed?.output_directory;
  const relative = (value) =>
    typeof value === "string" &&
    Buffer.byteLength(value) <= 2048 &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    (value === "" ||
      (!path.posix.isAbsolute(value) &&
        path.posix.normalize(value) === value &&
        !value
          .split("/")
          .some((part) => !part || part === "." || part === "..")));
  const token = (value, size) =>
    Array.isArray(value) &&
    value.length === size &&
    value.every((part) => typeof part === "string" && /^\d+$/.test(part));
  if (
    typeof root !== "string" ||
    !path.posix.isAbsolute(root) ||
    path.posix.normalize(root) !== root ||
    !root.endsWith("/tameduck/outputs") ||
    /[\x00-\x1f\x7f]/.test(root) ||
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.directories) ||
    parsed.files.length + parsed.directories.length > 10001 ||
    parsed.files.some(
      (file) =>
        typeof file?.path !== "string" ||
        !file.path.startsWith(root + "/") ||
        !relative(file.path.slice(root.length + 1)) ||
        !token(file.token, 5),
    ) ||
    parsed.directories.some(
      (directory) =>
        !relative(directory?.relative_path) || !token(directory.token, 2),
    )
  )
    throw providerFailure();
  return parsed;
}

export const computerFileExportInternals = {
  CHUNK_BYTES,
  preparePython,
  chunkPython,
  finishPython,
};
