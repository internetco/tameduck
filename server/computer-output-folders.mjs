const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const quote = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
const python = (script, args) =>
  "python3 -c " + quote(script) + " " + args.map(quote).join(" ");
const providerFailure = () =>
  Object.assign(new Error("The computer output operation failed."), {
    status: 502,
  });
const script = String.raw`
import ctypes,json,os,stat,sys
op,rel,target=sys.argv[1],sys.argv[2],sys.argv[3] or None
home=os.path.abspath(os.path.expanduser('~')); uid=os.geteuid()
root=os.path.join(home,'tameduck','outputs')
if home=='/' or not os.path.isabs(home): raise RuntimeError('unsafe home')
D=os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0); N=getattr(os,'O_NOFOLLOW',0)
def own(fd,kind='dir'):
 s=os.fstat(fd)
 if s.st_uid!=uid or (kind=='dir' and not stat.S_ISDIR(s.st_mode)): raise RuntimeError('unsafe ownership')
 if kind=='file' and (not stat.S_ISREG(s.st_mode) or s.st_nlink!=1): raise RuntimeError('unsafe file')
def openroot():
 h=os.open(home,D); own(h)
 try:
  try: t=os.open('tameduck',D,dir_fd=h)
  except FileNotFoundError: os.mkdir('tameduck',0o700,dir_fd=h); t=os.open('tameduck',D,dir_fd=h)
  own(t)
  try:
   try: r=os.open('outputs',D,dir_fd=t)
   except FileNotFoundError: os.mkdir('outputs',0o700,dir_fd=t); r=os.open('outputs',D,dir_fd=t)
   own(r)
  finally: os.close(t)
 finally: os.close(h)
 return r
def comps(p):
 if not p or p.startswith('/') or '\\' in p or any(c in p for c in '\x00\r\n\t') or len(p)>1024: raise ValueError('invalid path')
 a=p.split('/')
 if len(a)>8 or any(not x or x in ('.','..') or len(x.encode('utf8'))>255 for x in a): raise ValueError('invalid path')
 return a
def parent(fd,a,create=False):
 cur=os.dup(fd)
 try:
  for x in a[:-1]:
   try: n=os.open(x,D,dir_fd=cur)
   except FileNotFoundError:
    if not create: raise
    os.mkdir(x,0o700,dir_fd=cur); n=os.open(x,D,dir_fd=cur)
   own(n); os.close(cur); cur=n
  return cur,a[-1]
 except: os.close(cur); raise
def statentry(fd,name): return os.stat(name,dir_fd=fd,follow_symlinks=False)
def noreplace(fd1,n1,fd2,n2):
 libc=ctypes.CDLL(None,use_errno=True); nr=1
 fn=getattr(libc,'renameat2',None)
 if fn is None: raise RuntimeError('atomic no-clobber unavailable')
 fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 if fn(fd1,n1.encode(),fd2,n2.encode(),nr)!=0:
  e=ctypes.get_errno(); raise FileExistsError() if e==17 else OSError(e,os.strerror(e))
def inspect(fd,limit=10000):
 count=0
 def walk(d,depth=0):
  nonlocal count
  if depth>8: raise RuntimeError('scan depth')
  for n in os.listdir(d):
   count+=1
   if count>limit: raise RuntimeError('scan limit')
   s=statentry(d,n)
   if stat.S_ISLNK(s.st_mode) or s.st_uid!=uid: raise RuntimeError('unsafe entry')
   if stat.S_ISDIR(s.st_mode):
    c=os.open(n,D,dir_fd=d); own(c); walk(c,depth+1); os.close(c)
   elif stat.S_ISREG(s.st_mode):
    if s.st_nlink!=1: raise RuntimeError('unsafe file')
   else: raise RuntimeError('unsafe entry')
 walk(fd)
def output(p): return os.path.join(home,'tameduck','outputs',*p)
def main():
 r=openroot(); a=comps(rel)
 if op=='create':
  p,n=parent(r,a,True)
  try:
   created=False
   try: s=statentry(p,n)
   except FileNotFoundError: os.mkdir(n,0o700,dir_fd=p); s=statentry(p,n); created=True
   if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise FileExistsError()
  finally: os.close(p); os.close(r)
  return {'path':output(a),'output_directory':root,'created':created}
 if op=='delete':
  try: p,n=parent(r,a)
  except FileNotFoundError:
   os.close(r); return {'path':output(a),'output_directory':root,'already_missing':True}
  try: s=statentry(p,n)
  except FileNotFoundError:
   os.close(p); os.close(r); return {'path':output(a),'output_directory':root,'already_missing':True}
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise RuntimeError('not directory')
  d=os.open(n,D,dir_fd=p); own(d); inspect(d)
  if os.listdir(d): raise OSError(39,'not empty')
  os.rmdir(n,dir_fd=p); os.close(d); os.close(p); os.close(r)
  return {'path':output(a),'output_directory':root}
 if op in ('rename','move_file'):
  if not target: raise ValueError('target required')
  b=comps(target)
  if op=='rename' and (len(b)>len(a) and b[:len(a)]==a): raise ValueError('target descendant')
  sp,sn=parent(r,a); dp,dn=parent(r,b,False)
  try:
   s=statentry(sp,sn); ownkind='dir' if op=='rename' else 'file'
   own(sp); own(dp)
   if op=='rename':
    if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid: raise RuntimeError('not directory')
    d=os.open(sn,D,dir_fd=sp); own(d); inspect(d); os.close(d)
   else: fd=os.open(sn,os.O_RDONLY|N|getattr(os,'O_NONBLOCK',0),dir_fd=sp); own(fd,'file'); os.close(fd)
   try: statentry(dp,dn); raise FileExistsError()
   except FileNotFoundError: pass
   noreplace(sp,sn,dp,dn)
  finally: os.close(sp); os.close(dp); os.close(r)
  return {'path':output(b),'output_directory':root,'source_path':output(a),'target':output(b)}
 raise ValueError('invalid operation')
try: print(json.dumps(main(),separators=(',',':')))
except FileExistsError: print(json.dumps({'error':'conflict','status':409}))
except NotADirectoryError: print(json.dumps({'error':'unsafe directory','status':400}))
except (ValueError,RuntimeError,PermissionError,FileNotFoundError) as e: print(json.dumps({'error':str(e),'status':400}))
except OSError as e: print(json.dumps({'error':'not empty' if e.errno in (39,66) else 'unsafe output entry','status':409 if e.errno in (39,66) else 400}))
`;
async function command(request, boxId, command, guard) {
  await guard();
  let r;
  try {
    r = await request(
      `/boxes/${encodeURIComponent(boxId)}/commands`,
      `POST`,
      { command, timeoutSeconds: 60 },
      { timeout: 67000, sensitive: true },
    );
  } catch {
    throw providerFailure();
  }
  if (!r?.success || r.exitCode !== 0 || r.timedOut) throw providerFailure();
  await guard();
  return String(r.stdout || "").trim();
}
export async function mutateComputerOutputFolder({
  request,
  boxId,
  operation,
  path: relative,
  target,
  guard = () => {},
}) {
  if (typeof request !== "function" || !boxId)
    fail(500, "Computer output folders are unavailable right now.");
  if (!["create", "rename", "delete", "move_file"].includes(operation))
    fail(400, "Invalid output folder operation.");
  const valid = (v) =>
    typeof v === "string" &&
    v.length > 0 &&
    Buffer.byteLength(v) <= 2048 &&
    !v.startsWith("/") &&
    !v.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(v) &&
    !v
      .split("/")
      .some(
        (x) => !x || x === "." || x === ".." || Buffer.byteLength(x) > 255,
      ) &&
    v.split("/").length <= 8;
  if (!valid(relative) || (target !== undefined && !valid(target)))
    fail(400, "Choose a normalized relative output path.");
  let text = await command(
    request,
    boxId,
    python(script, [operation, relative, target || ""]),
    guard,
  );
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw providerFailure();
  }
  if (out?.status) fail(out.status, out.error || "Output operation failed.");
  const root = out?.output_directory;
  if (
    typeof root !== "string" ||
    !path.posix.isAbsolute(root) ||
    path.posix.normalize(root) !== root ||
    !root.endsWith("/tameduck/outputs") ||
    /[\x00-\x1f\x7f]/.test(root) ||
    out.path !==
      root +
        "/" +
        (["rename", "move_file"].includes(operation) ? target : relative)
  )
    throw providerFailure();
  return out;
}
import path from "node:path";
