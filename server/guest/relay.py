"""One-use TLS relay for a single local desktop/browser socket. No input logging."""
import base64,hashlib,ipaddress,json,os,pathlib,secrets,socket,ssl,struct,sys,tempfile,threading,urllib.parse

CONTROL_MARK = 0x544451
CONTROL_CONFIG = pathlib.Path('/var/lib/tameduck-control/endpoint.json')
PROXY_CONFIG = pathlib.Path('/var/lib/tameduck-proxy/config.json')

def read_json(path):
 try:return json.loads(path.read_text())
 except (OSError,ValueError):return {}

def configure_control(host,port,config_path=CONTROL_CONFIG,proxy_path=PROXY_CONFIG):
 if not isinstance(host,str) or not host or len(host)>253 or not all(c.isalnum() or c in '.-' for c in host):raise ValueError('invalid_control_host')
 port=int(port)
 if not 1<=port<=65535:raise ValueError('invalid_control_port')
 old=read_json(config_path)
 previous=old.get('ips',[]) if old.get('host')==host and old.get('port')==port else []
 if proxy_path.exists():
  # nft is already active: use only the destination set installed with it.
  active=read_json(proxy_path)
  ips=active.get('control_ips',[]) if active.get('control_port')==port else []
  if not ips:raise RuntimeError('control_route_unavailable')
 else:
  try:fresh=[x[4][0] for x in socket.getaddrinfo(host,port,socket.AF_INET,socket.SOCK_STREAM)]
  except OSError:fresh=[]
  ips=list(dict.fromkeys(fresh+previous))[:8]
  if not ips:raise RuntimeError('control_endpoint_unavailable')
 ips=[str(ipaddress.IPv4Address(ip)) for ip in ips]
 config_path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd,tmp=tempfile.mkstemp(prefix='.endpoint-',dir=config_path.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'w') as file:
   json.dump({'host':host,'port':port,'ips':ips},file,separators=(',',':'))
   file.flush();os.fsync(file.fileno())
  os.replace(tmp,config_path)
 finally:
  try:os.unlink(tmp)
  except FileNotFoundError:pass
 return {'host':host,'port':port,'ips':ips}

def connect_control(url,config_path=CONTROL_CONFIG,timeout=10):
 parsed=urllib.parse.urlsplit(url);host=parsed.hostname;port=parsed.port or 443
 config=read_json(config_path)
 if parsed.scheme!='https' or host!=config.get('host') or port!=config.get('port'):
  raise ValueError('untrusted_control_endpoint')
 ips=config.get('ips',[])
 if not ips:raise RuntimeError('control_route_unavailable')
 last=None
 for ip in ips:
  candidate=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
  try:
   candidate.setsockopt(socket.SOL_SOCKET,socket.SO_MARK,CONTROL_MARK)
   candidate.settimeout(timeout)
   candidate.connect((str(ipaddress.IPv4Address(ip)),port))
   return ssl.create_default_context().wrap_socket(candidate,server_hostname=host)
  except Exception as error:
   last=error;candidate.close()
 raise ConnectionError('control_endpoint_unreachable') from last

def main():
 if len(sys.argv)==4 and sys.argv[1]=='--configure':
  configure_control(sys.argv[2],sys.argv[3]);return
 url=urllib.parse.urlsplit(sys.argv[1]);token=sys.argv[2];port=int(sys.argv[3])
 if url.scheme!='https' or port not in (5901,9223):return
 remote=connect_control(sys.argv[1])
 key=base64.b64encode(secrets.token_bytes(16)).decode()
 host=url.hostname+(':'+str(url.port) if url.port else '')
 remote.sendall(('GET '+url.path+' HTTP/1.1\r\nHost: '+host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer '+token+'\r\n\r\n').encode())
 token='';sys.argv[2]=''
 header=b''
 while not header.endswith(b'\r\n\r\n'):
  byte=remote.recv(1)
  if not byte or len(header)>16384:raise ValueError('handshake')
  header+=byte
 lines=header.decode().split('\r\n');headers=dict(line.split(':',1) for line in lines[1:] if ':' in line)
 headers={k.lower():v.strip() for k,v in headers.items()}
 expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
 if ' 101 ' not in lines[0] or headers.get('sec-websocket-accept')!=expected:raise ValueError('handshake')
 local=socket.create_connection(('127.0.0.1',port),10);remote.settimeout(1000);local.settimeout(1000)
 lock=threading.Lock()
 def send(data,opcode=2):
  mask=secrets.token_bytes(4);n=len(data)
  head=bytes([128|opcode,128|n]) if n<126 else bytes([128|opcode,128|126])+struct.pack('!H',n) if n<65536 else bytes([128|opcode,128|127])+struct.pack('!Q',n)
  # Mask a whole frame at once. The per-byte loop this replaces held desktop and
  # browser traffic to a few MB/s, which showed up as a stuttering screen.
  payload=(int.from_bytes(data,'big')^int.from_bytes((mask*(n//4+1))[:n],'big')).to_bytes(n,'big') if n else b''
  with lock:remote.sendall(head+mask+payload)
 def upstream():
  try:
   while True:
    data=local.recv(32768)
    if not data:break
    send(data)
  finally:
   try:remote.shutdown(socket.SHUT_RDWR)
   except OSError:pass
 def read(n):
  data=b''
  while len(data)<n:
   block=remote.recv(n-len(data))
   if not block:raise EOFError()
   data+=block
  return data
 threading.Thread(target=upstream,daemon=True).start()
 try:
  while True:
   first,second=read(2);opcode=first&15;n=second&127
   if second&128:raise ValueError('server masking')
   if n==126:n=struct.unpack('!H',read(2))[0]
   elif n==127:n=struct.unpack('!Q',read(8))[0]
   if n>131072:raise ValueError('frame too large')
   data=read(n)
   if opcode in (0,2):local.sendall(data)
   elif opcode==8:break
   elif opcode==9:send(data,10)
   elif opcode!=10:raise ValueError('unexpected frame')
 finally:local.close();remote.close()

if __name__=='__main__':
 try:main()
 except Exception:sys.exit(1)
