"""Persistent desktop transport; each app request remains bounded and never retried."""
import subprocess,json,sys,base64,io,os,socket,pathlib,uuid,signal,traceback,urllib.request,shlex,time,re,math
base=pathlib.Path.home()/'tameduck'
sockpath=str(base/'control.sock')
# The desktop's own control binary. Named here so a test can put a fake one in
# its place and drive the session handling below; nothing else ever sets this.
cua=os.environ.get('TAMEDUCK_CUA_DRIVER','/opt/ascii/cua-driver/cua-driver')
# Where that binary's daemon listens. Named for the same reason as above.
provider=os.environ.get('TAMEDUCK_PROVIDER_SOCKET','/run/ascii-cua/driver.sock')

def systemctl(*args):
 env={**os.environ};env.setdefault('XDG_RUNTIME_DIR','/run/user/%d'%os.getuid())
 try:return subprocess.run(['systemctl','--user',*args],env=env,timeout=10,capture_output=True,text=True).stdout.strip()
 except (OSError,subprocess.TimeoutExpired):return ''

def restart(unit):
 # Only ever called before anything has been sent, so it cannot repeat an
 # action.
 systemctl('restart',unit)

def provider_ready():
 # The desktop daemon can lose its socket and keep running. On the image the
 # provider shipped on 23 September it restarts itself a few seconds after
 # boot, and about seven seconds later the file it listens on is gone - the
 # daemon still up, and nothing able to reach it. Every action on every new
 # computer then failed as "Desktop connection was interrupted". A restart
 # makes a socket that stays.
 if os.path.exists(provider):return
 restart('cua-driver.service')
 deadline=time.monotonic()+8
 while not os.path.exists(provider) and time.monotonic()<deadline:time.sleep(.2)

def save_browser():
 # Keep a second record of open pages: Chrome session files can lag at snapshot time.
 try:
  with urllib.request.urlopen('http://127.0.0.1:9223/json/list',timeout=1) as response:tabs=json.load(response)
  urls=list(dict.fromkeys(t.get('url') for t in tabs if t.get('type')=='page' and t.get('url','').startswith(('https://','http://'))))
  restoring=base/'browser-restoring'
  if not urls and restoring.exists():return
  if restoring.exists():restoring.unlink()
  target=base/'browser-tabs.json';temporary=base/'browser-tabs.tmp'
  with open(temporary,'w') as f:json.dump({'urls':urls},f);f.flush();os.fsync(f.fileno())
  os.chmod(temporary,0o600);os.replace(temporary,target)
 # Deliberately everything. This is bookkeeping that runs after every desktop
 # action, and nothing it can hit is worth failing that action for. It caught
 # only OSError and ValueError, so when anything other than Chrome answered on
 # the debugging port - or Chrome answered mid-restart - urlopen raised
 # BadStatusLine, which is neither, and the click or screenshot that had already
 # succeeded came back to the duck as "Desktop connection was interrupted".
 except Exception:pass

def clipboard_environment():
 env={**os.environ,'DISPLAY':os.environ.get('DISPLAY') or ':0'}
 env.setdefault('XAUTHORITY',str(pathlib.Path.home()/'.Xauthority'))
 return env

def clipboard_text(env,selection):
 # Keep clipboard bytes in memory. Never pass pasted text through argv, a shell,
 # stderr, or the desktop action log.
 result=subprocess.run(['xclip','-selection',selection,'-out','-t','UTF8_STRING'],
                       env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=2)
 return result.stdout if result.returncode==0 else None

def set_clipboard(text,env,selection):
 result=subprocess.run(['xclip','-selection',selection,'-in','-t','UTF8_STRING'],
                       input=text,env=env,stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL,timeout=3)
 if result.returncode:raise RuntimeError('Desktop clipboard could not be set')

def paste_text(args,ask):
 value=args.get('text')
 if args.get('scope')!='desktop' or not isinstance(value,str) or not value or len(value)>4000:
  raise ValueError('Invalid desktop paste')
 data=value.encode('utf-8')
 env=clipboard_environment()
 for selection in ('clipboard','primary'):
  set_clipboard(data,env,selection)
 # An X11 selection is served by its owner process. Verify it is ready before
 # asking the focused application to paste; otherwise a hotkey can succeed
 # while the application receives no bytes. Keep the clipboard available after
 # the hotkey: some applications request it well after the key event returns.
 if any(clipboard_text(env,selection)!=data for selection in ('clipboard','primary')):
  raise RuntimeError('Desktop clipboard was not ready')
 return ask('hotkey',{'keys':['shift','insert'],'scope':'desktop'})


def desktop_target_requested(args):
 target=args.get('target')
 return args.get('scope')=='desktop' or (isinstance(target,dict) and target.get('kind')=='desktop')

def desktop_keyboard_focus_requested(tool,args):
 return tool in ('press_key','hotkey') and ('x' in args or 'y' in args) and desktop_target_requested(args)

def clipboard_foreground_text(tool,args):
 value=args.get('text')
 return (tool=='type_text' and args.get('delivery_mode')=='foreground' and
         isinstance(value,str) and (any(ord(ch)>127 for ch in value) or
          desktop_target_requested(args)))

def native_unicode_refusal(code,message):
 return {'isError':True,'content':[{'type':'text','text':message}],
         'structuredContent':{'status':'refused','effect':'refused',
                              'refusal':{'code':code}}}

def native_unicode_text(args,ask):
 # XSendEvent cannot carry Unicode, and the global type route ignores x/y.
 # Focus explicitly, then paste the verified UTF8_STRING selection once.
 value=args['text']
 if not value:
  return ask('type_text',args)
 pid=args.get('pid');window_id=args.get('window_id');target=args.get('target')
 legacy_present='pid' in args or 'window_id' in args
 legacy=(type(pid) is int and pid>0 and type(window_id) is int and window_id>0)
 targeted=(isinstance(target,dict) and target.get('kind')=='window' and
           type(target.get('pid')) is int and target['pid']>0 and
           type(target.get('window_id')) is int and target['window_id']>0)
 exact=((not legacy_present or legacy) and (target is None or targeted) and
        (legacy or targeted) and
        (not legacy or not targeted or
         (pid==target['pid'] and window_id==target['window_id'])))
 window=(exact and args.get('scope') in (None,'window'))
 desktop=(not legacy_present and args.get('scope') in (None,'desktop') and
          (args.get('scope')=='desktop' or (isinstance(target,dict) and target.get('kind')=='desktop')) and
          (target is None or (isinstance(target,dict) and target.get('kind')=='desktop' and target.get('display_id')=='primary')) and
          not any(k in args for k in ('element_index','element_token','snapshot_id','from_zoom')))
 if not window and not desktop:
  return native_unicode_refusal('native_text_target_required',
    'Text input requires the primary desktop or one exact native window, without mixing target coordinate spaces. No input was sent.')
 if ('x' in args)!=('y' in args):
  return native_unicode_refusal('native_text_coordinates_required',
    'Text input needs both x and y for a pixel focus target. No input was sent.')
 data=value.encode('utf-8')
 env=clipboard_environment()
 for selection in ('clipboard','primary'):
  set_clipboard(data,env,selection)
 if any(clipboard_text(env,selection)!=data for selection in ('clipboard','primary')):
  raise RuntimeError('Desktop clipboard was not ready')
 keep=('pid','window_id','session','scope','target')
 target_args={key:args[key] for key in keep if key in args}
 target_args['delivery_mode']='foreground'
 focus=('x','y','element_index','element_token','snapshot_id')
 requested=any(key in args for key in focus)
 if requested:
  click={**target_args,**{key:args[key] for key in focus if key in args}}
  result=ask('click',click)
  state=result.get('structuredContent') or {}
  if (result.get('isError') or state.get('status') in ('refused','error','failed') or
      state.get('effect') in ('refused','error','failed') or
      isinstance(state.get('refusal'),dict)):
   return result
 # Do not add text or a coordinate to this request: the click above chose the
 # field, and a second targeting click could change selection or caret.
 return ask('hotkey',{**target_args,'keys':['shift','insert']})

def foreground_unavailable(result):
 # Only this explicit provider refusal proves no input was sent. Never repair
 # timeouts, transport errors, or an unverifiable result.
 if not isinstance(result,dict) or not result.get('isError'):return False
 text='\n'.join(i.get('text','') for i in result.get('content',[]) if i.get('type')=='text')
 return 'foreground_unavailable:' in text and 'no input was sent' in text.lower()

def foreground_recovery(ask,args):
 # Recovery is allowed only for one exact, visible browser window. It uses the
 # provider's bring_to_front permission before the bounded X11 focus refresh.
 pid=args.get('pid');wid=args.get('window_id')
 if type(pid) is not int or pid<=0 or type(wid) is not int or wid<=0:
  return None,'exact_window_required'
 windows=ask('list_windows',{'pid':pid,'on_screen_only':True})
 observed=(windows.get('structuredContent') or {}).get('windows',[])
 matches=[w for w in observed if w.get('pid')==pid and w.get('window_id')==wid and w.get('is_on_screen') is True]
 if windows.get('isError') or len(matches)!=1:
  return None,'window_unavailable'
 app=str(matches[0].get('app_name','')).lower()
 if app not in ('google-chrome','google-chrome-stable','chromium','chromium-browser','chrome','microsoft-edge','microsoft-edge-stable'):
  return None,'browser_window_required'
 approved=ask('bring_to_front',{'pid':pid,'window_id':wid})
 state=approved.get('structuredContent') or {}
 if (approved.get('isError') or state.get('window_id')!=wid or
     state.get('status') in ('refused','error','failed') or
     state.get('effect') in ('refused','error','failed') or
     isinstance(state.get('refusal'),dict)):
  return None,'focus_authorization_unverified'
 refreshed=refresh_window_focus(wid)
 if refreshed!='refreshed':return None,'focus_refresh_failed'
 return {'pid':pid,'window_id':wid},'refreshed'

FOREGROUND_RECOVERY_TOOLS=set(('click','double_click','right_click','drag','type_text','press_key','hotkey','scroll'))

def foreground_retry(send,tool,args):
 # Retry only the final native provider action after a proven no-input refusal.
 result=send(tool,args)
 if tool not in FOREGROUND_RECOVERY_TOOLS:return result
 if not foreground_unavailable(result):return result
 # Preserve the provider's proven no-input semantics for the caller's focus
 # guard, even when this provider only put the refusal code in text.
 def refused(value):
  state=value.get('structuredContent') or {}
  return {**value,'structuredContent':{**state,'status':'refused','effect':'refused','refusal':{'code':'foreground_unavailable'}}}
 result=refused(result)
 native,recovery=foreground_recovery(send,args)
 if native is None:
  state=result.get('structuredContent') or {}
  return {**result,'structuredContent':{**state,'foreground_recovery':{'attempted':True,'status':recovery,'retried':False}}}
 retried=send(tool,args)
 if foreground_unavailable(retried):retried=refused(retried)
 state=retried.get('structuredContent') or {}
 return {**retried,'structuredContent':{**state,'foreground_recovery':{'attempted':True,'status':recovery,'retried':True}}}

def desktop_keyboard_focus(tool,args,ask):
 # The provider's desktop keyboard route ignores x/y. Focus once explicitly
 # before the key/shortcut; never pass the coordinates to a second action.
 target=args.get('target')
 if (any(k in args for k in ('pid','window_id','element_index','element_token','snapshot_id','from_zoom')) or
     args.get('scope') not in (None,'desktop') or
     (target is not None and target!={'kind':'desktop','display_id':'primary'})):
  return native_unicode_refusal('native_text_target_required','Desktop keyboard input cannot mix window targets. No input was sent.')
 if ('x' in args)!=('y' in args):
  return native_unicode_refusal('native_text_coordinates_required','Desktop keyboard input needs both x and y. No input was sent.')
 focus={k:args[k] for k in ('x','y','scope','target','session','delivery_mode') if k in args}
 result=ask('click',focus)
 state=result.get('structuredContent') or {}
 if (result.get('isError') or state.get('status') in ('refused','error','failed') or
     state.get('effect') in ('refused','error','failed') or isinstance(state.get('refusal'),dict)):
  return result
 return ask(tool,{k:v for k,v in args.items() if k not in ('x','y')})

def refresh_window_focus(window_id,run=None):
 """One bounded X11 FocusOut/In after provider-authorized exact-window activation.

 No shell, page text, or arbitrary window id reaches a subprocess command.
 The target is restored even if moving focus to the dynamic root partly fails.
 """
 if run is None:run=subprocess.run
 env=clipboard_environment()
 env['LC_ALL']='C'
 def call(argv,capture=False):
  return run(argv,env=env,timeout=2,
             stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
             stderr=subprocess.DEVNULL,text=True)
 def focus():
  result=call(['xdotool','getwindowfocus'],True)
  if result.returncode:return None
  value=(result.stdout or '').strip()
  return int(value) if value.isdecimal() else None
 try:
  if focus()!=window_id:return 'focus_mismatch'
  root=call(['xwininfo','-root','-int'],True)
  found=re.search(r'Window id:\s*([0-9]+)\b',root.stdout or '') if root.returncode==0 else None
  if not found:return 'root_unavailable'
  root_id=int(found.group(1))
  if root_id<=0 or root_id==window_id:return 'root_unavailable'
 except (OSError,ValueError,subprocess.TimeoutExpired):return 'focus_unavailable'
 root_ok=restore_ok=False
 try:
  # The window manager may refocus the browser before a separate X focus read.
  # The bounded root call's success plus final target focus and address copy
  # are the useful evidence; an intermediate root snapshot is not stable.
  root_ok=call(['xdotool','windowfocus','--sync',str(root_id)]).returncode==0
 except (OSError,subprocess.TimeoutExpired):pass
 finally:
  try:restore_ok=call(['xdotool','windowfocus','--sync',str(window_id)]).returncode==0
  except (OSError,subprocess.TimeoutExpired):pass
 try:verified=focus()==window_id
 except (OSError,ValueError,subprocess.TimeoutExpired):verified=False
 return 'refreshed' if root_ok and restore_ok and verified else 'focus_refresh_failed'

def open_page(args,ask,read_clipboard=None,write_clipboard=None,sleep=time.sleep,inspect_only=False,refresh_focus=None):
 """Enter and read back one URL in an observed native Chromium window.

 This proves address entry and Enter dispatch, never document loading. No
 whole sequence is retried. Copy acknowledgement uses a unique non-URL
 sentinel, so reading back our own paste buffer cannot prove insertion.
 """
 from urllib.parse import urlsplit
 def address(value):
  if not isinstance(value,str) or not value or len(value)>4000 or any(ord(c)<32 for c in value):return None
  try:
   p=urlsplit(value)
   if p.scheme not in ('http','https') or not p.hostname or p.username is not None or p.password is not None:return None
   return (p.scheme,p.hostname.lower(),p.port,p.path or '/',p.query,p.fragment)
  except ValueError:return None
 # A changed clipboard alone can be selected page text when Ctrl+L missed the
 # omnibox. Admit only a copied HTTP(S) address or these exact blank/new-tab
 # browser addresses before a later paste is allowed.
 internal_addresses=('about:blank','chrome://newtab/','edge://newtab/')
 def copied_address(value):
  http=address(value) is not None and not any(c.isspace() for c in value)
  return http or value in internal_addresses
 url=args.get('url');pid=args.get('pid');wid=args.get('window_id')
 state={'requested_url':url,'previous_url':None,'observed_url':None,
        'address_entered':False,'navigation_sent':False,'phase':'validate',
        'focus_recovery_attempted':False,'focus_recovery_result':None}
 touched=False
 def finish(code=None,refused=False):
  status='ok' if code is None else ('refused' if refused and not touched else 'uncertain')
  result='address_verified' if code is None else status
  effect='sent' if code is None else ('refused' if not touched else 'unverifiable')
  text=('The address was entered and Enter was sent once. The current address was read back. '
        'This does not prove the page loaded or the task succeeded.' if code is None else
        ('Browser setup is required ('+code+'). Call browser_prepare with pid '+str(pid)+
         ', window_id '+str(wid)+', strategy.kind=existing_profile after any required consent, '
         'then retry open_page. No URL was entered.' if code in ('browser_consent_required','browser_requires_setup') else
         'Page opening could not be verified ('+code+'). Inspect the current screen; do not claim the requested site was reached or blindly repeat the action.'))
  return {'isError':code is not None,'content':[{'type':'text','text':text}],
          'structuredContent':{**state,'status':status,'result':result,'effect':effect,**({'code':code} if code else {})}}
 if ((not inspect_only and not address(url)) or type(pid) is not int or pid<=0 or type(wid) is not int or wid<=0 or
     any(k not in ('url','pid','window_id','session') for k in args)):
  return finish('open_page_invalid_target',True)
 target={'pid':pid,'window_id':wid,'scope':'window','delivery_mode':'foreground'}
 if args.get('session'):target['session']=args['session']
 env=clipboard_environment()
 if read_clipboard is None:
  def read_clipboard():
   data=clipboard_text(env,'clipboard')
   return data.decode('utf-8',errors='strict') if data is not None else None
 if write_clipboard is None:
  def write_clipboard(value):set_clipboard(value.encode('utf-8'),env,'clipboard')
 def good(result):
  s=(result or {}).get('structuredContent') or {}
  return not ((result or {}).get('isError') or s.get('status') in ('refused','error','failed') or
              s.get('effect') in ('refused','error','failed') or isinstance(s.get('refusal'),dict))
 class Stopped(Exception):
  pass
 def send(tool,extra):
  nonlocal touched
  result=ask(tool,{**target,**extra})
  if not good(result):raise Stopped('native_control_refused')
  touched=True
  return result
 def read_address():
  send('hotkey',{'keys':['ctrl','l']})
  sentinel='td-address-copy-'+uuid.uuid4().hex
  write_clipboard(sentinel)
  send('hotkey',{'keys':['ctrl','c']})
  # Poll clipboard consumption, not input. Never resend Ctrl+C or a paste.
  for attempt in range(16):
   value=read_clipboard()
   if value is not None and value!=sentinel:
    return True,value if address(value) and not any(c.isspace() for c in value) else None,copied_address(value)
   if attempt<15:sleep(.05)
  return False,None,False
 def exact_browser_window(result):
  observed=(result.get('structuredContent') or {}).get('windows',[])
  matches=[w for w in observed if w.get('pid')==pid and w.get('window_id')==wid and w.get('is_on_screen') is True]
  if len(matches)!=1:return False
  return str(matches[0].get('app_name','')).lower() in ('google-chrome','google-chrome-stable','chromium','chromium-browser','chrome','microsoft-edge','microsoft-edge-stable')
 def bound_new_tab():
  # Chrome leaves its New Tab omnibox empty, so Ctrl+C cannot acknowledge a
  # clipboard sentinel. Only an exact native-window browser binding can prove
  # that case; a title or an empty clipboard is not sufficient.
  binding_args={'pid':pid,'window_id':wid}
  if args.get('session'):binding_args['session']=args['session']
  result=ask('get_browser_state',binding_args)
  bound=(result or {}).get('structuredContent') or {}
  status=bound.get('status')
  state['browser_binding_status']=status if status in ('ok','refused','error','failed') else 'unrecognized'
  refusal=bound.get('refusal')
  raw_code=refusal.get('code') if isinstance(refusal,dict) else None
  setup_codes=('browser_consent_required','browser_requires_setup')
  state['browser_binding_code']=(raw_code if raw_code in setup_codes else
                                 'other' if raw_code is not None else None)
  def unavailable(reason):
   state['browser_binding_diagnostic']=reason
   return None
  # Exact bind correlates to the requested native window. Reject any contrary
  # identity returned by the provider as well.
  if ('pid' in bound and bound['pid']!=pid) or ('window_id' in bound and bound['window_id']!=wid):return unavailable('identity_mismatch')
  if status=='refused' and raw_code in setup_codes:
   next_args={'pid':pid,'window_id':wid,'strategy':{'kind':'existing_profile'}}
   if args.get('session'):next_args['session']=args['session']
   state['next_supported_step']={'tool':'browser_prepare','arguments':next_args}
   return unavailable('setup_required')
  if not good(result) or status!='ok':return unavailable('binding_unavailable')
  if (bound.get('mode')!='bind' or bound.get('binding_quality')!='exact' or
      bound.get('mutation_allowed') is not True or
      not isinstance(bound.get('target_id'),str) or not bound['target_id']):return unavailable('inexact_binding')
  tabs=bound.get('tabs')
  if not isinstance(tabs,list) or not tabs or any(not isinstance(tab,dict) for tab in tabs):return unavailable('tabs_unavailable')
  active=[tab for tab in tabs if tab.get('active') is True]
  if len(active)==1:tab=active[0]
  elif not active and len(tabs)==1 and tabs[0].get('active') is not False:tab=tabs[0]
  else:return unavailable('active_tab_ambiguous')
  if not isinstance(tab.get('tab_id'),str) or not tab['tab_id']:return unavailable('tab_id_unavailable')
  if tab.get('url') not in internal_addresses:return unavailable('not_internal_address')
  state['browser_binding_diagnostic']='exact_internal_tab'
  return tab['url']
 try:
  windows=ask('list_windows',{'pid':pid,'on_screen_only':True})
  if not good(windows):return finish('open_page_window_unavailable',True)
  observed=(windows.get('structuredContent') or {}).get('windows',[])
  matches=[w for w in observed if w.get('pid')==pid and w.get('window_id')==wid and w.get('is_on_screen') is True]
  if len(matches)!=1:return finish('open_page_window_unavailable',True)
  app=str(matches[0].get('app_name','')).lower()
  if app not in ('google-chrome','google-chrome-stable','chromium','chromium-browser','chrome','microsoft-edge','microsoft-edge-stable'):
   return finish('open_page_browser_required',True)
  state['phase']='read_previous_address'
  acknowledged,state['previous_url'],recognized=read_address()
  initial_copy_unacknowledged=not acknowledged
  if not inspect_only and (not acknowledged or not recognized):
   # A copied page selection is not an address. Revalidate the same native
   # browser window and obtain provider authorization before touching X focus.
   state['focus_recovery_attempted']=True
   state['phase']='refresh_focus'
   fresh=ask('list_windows',{'pid':pid,'on_screen_only':True})
   if not good(fresh) or not exact_browser_window(fresh):
    state['focus_recovery_result']='window_unavailable'
    return finish('open_page_focus_window_unavailable')
   state['focus_recovery_result']='provider_unavailable'
   approved=ask('bring_to_front',{'pid':pid,'window_id':wid})
   if not good(approved):
    state['focus_recovery_result']='provider_refused'
    return finish('native_control_refused',True)
   if (approved.get('structuredContent') or {}).get('window_id')!=wid:
    state['focus_recovery_result']='provider_unverified'
    return finish('open_page_focus_authorization_unverified')
   state['focus_recovery_result']='focus_unavailable'
   refresh=refresh_focus or refresh_window_focus
   state['focus_recovery_result']=refresh(wid)
   if state['focus_recovery_result']!='refreshed':return finish('open_page_focus_refresh_unavailable')
   state['phase']='read_previous_address'
   acknowledged,state['previous_url'],recognized=read_address()
   state['focus_recovery_result']='address_recovered' if acknowledged and recognized else 'address_unverified'
   if initial_copy_unacknowledged and not acknowledged:
    internal=bound_new_tab()
    if internal:
     state['previous_url']=internal
     state['previous_address_source']='bound_new_tab'
     state['focus_recovery_result']='bound_new_tab'
     # Independent browser-state evidence replaces only the previous-address
     # check. Pasted URL and post-Enter readback still require native copies.
     acknowledged=True;recognized=True
   if not acknowledged:
    setup_code=state.get('browser_binding_code') if state.get('browser_binding_diagnostic')=='setup_required' else None
    return finish(setup_code or 'open_page_copy_unacknowledged')
   if not recognized:return finish('open_page_previous_address_unverified')
  if not acknowledged:return finish('open_page_copy_unacknowledged')
  if not recognized:return finish('open_page_previous_address_unverified')
  if inspect_only:
   state['observed_url']=state['previous_url']
   send('press_key',{'key':'ESC'})
   if not state['observed_url']:return finish('open_page_address_unavailable')
   return {'isError':False,'content':[{'type':'text','text':'The current browser address was copied from the observed native window. This does not prove page loading completed.'}],
           'structuredContent':{**state,'status':'ok','effect':'confirmed'}}
  # An explicit internal address is allowed, but arbitrary selected page text
  # must never authorize pasting into what might be page content.
  state['phase']='enter_address'
  # Ctrl+V uses CLIPBOARD explicitly. This avoids PRIMARY selection changing
  # when focus/selection changes and never synthesizes text key by key.
  send('hotkey',{'keys':['ctrl','l']})
  write_clipboard(url)
  if read_clipboard()!=url:return finish('open_page_clipboard_unavailable')
  send('hotkey',{'keys':['ctrl','v']})
  # Give the target its clipboard read before replacing CLIPBOARD with the
  # copy sentinel. Verification below still fails if it did not consume it.
  sleep(.12)
  state['phase']='verify_entered_address'
  acknowledged,entered,_=read_address()
  if not acknowledged:return finish('open_page_address_copy_unacknowledged')
  if address(entered)!=address(url):
   state['observed_url']=entered
   return finish('open_page_address_not_entered')
  state['address_entered']=True
  state['phase']='navigate'
  send('press_key',{'key':'ENTER'})
  state['navigation_sent']=True
  sleep(.15)
  state['phase']='read_current_address'
  acknowledged,state['observed_url'],_=read_address()
  send('press_key',{'key':'ESC'})
  if not acknowledged or state['observed_url'] is None:return finish('open_page_address_unavailable')
  state['phase']='address_verified'
  return finish()
 except Stopped as error:
  return finish(str(error),True)
 except Exception:
  # Private clipboard bytes and provider errors never enter receipts.
  return finish('open_page_observation_unavailable')


def composed_page_ask(ask,expired,reconnect,current_session):
 """Revive only an expired initial window read, before page input begins.

 A new implicit transport is needed for list_windows. Native child requests
 keep the caller's explicit session shape but use the freshly opened session.
 No hotkey, key press, paste, or whole page action is ever retried here.
 """
 reconnected=False
 native_attempted=False
 def call(tool,args):
  nonlocal reconnected,native_attempted
  if tool!='list_windows':native_attempted=True
  def current_args():
   return {**args,'session':current_session()} if 'session' in args else args
  result=ask(tool,current_args())
  if tool=='list_windows' and not native_attempted and not reconnected and expired(result):
   reconnected=True
   reconnect()
   result=ask(tool,current_args())
  return result
 return call


def managed_browser_launch(args):
 # Provider launches run in its daemon, not this process. Put the browser's
 # input settings in its launch command so a relaunch cannot inherit ibus.
 result={**args,'additional_arguments':[a.replace('__TAMEDUCK_PROFILE__',str(base/'chrome')) for a in args.get('additional_arguments',[])]}
 launch=args.get('launch_path') or args.get('name','')
 try:command=shlex.split(launch)
 except ValueError:return result,False
 executable=pathlib.Path(command[0]).name.lower() if command else ''
 names=('google-chrome','google-chrome-stable','chromium','chromium-browser','chrome')
 if executable not in names:
  if launch not in ('Google Chrome','Chromium','TameDuck Browser'):return result,False
  command=['google-chrome-stable']
 values=command[1:]+result['additional_arguments']
 if any(a.startswith('--remote-debugging') for a in values):
  # Keep the provider's browser preparation boundary when prefixing with env.
  return None,True
 kept=[];skip=False
 for value in values:
  if skip:skip=False;continue
  if value=='--user-data-dir':skip=True;continue
  if value.startswith('--user-data-dir='):continue
  kept.append(value)
 # The control service needs the user bus, but forcing that bus into
 # Chrome makes accepted native key events have no effect. Let Chrome
 # discover the desktop session bus itself.
 result['launch_path']='env -u DBUS_SESSION_BUS_ADDRESS GTK_IM_MODULE=none QT_IM_MODULE=none XMODIFIERS=@im=none '+shlex.quote(command[0])
 kept.insert(kept.index('--') if '--' in kept else len(kept),'--user-data-dir='+str(base/'chrome'))
 result['additional_arguments']=kept
 urls=result.pop('urls',[])
 if urls:
  # The provider sends urls to xdg-open even when launch_path is supplied.
  # Pass them as literal browser arguments to keep this launch's environment.
  result['additional_arguments']+=([] if '--' in kept else ['--'])+urls
 return result,True

def dispatch_action(tool,args,ask):
 if tool=='launch_app':
  launch,managed=managed_browser_launch(args)
  if managed and launch is None:
   return native_unicode_refusal('browser_prepare_required','Use browser_prepare for Chromium remote-debugging access. No application was launched.')
  return ask(tool,launch)
 if tool=='open_page':return open_page(args,ask)
 if tool=='read_page_address':return open_page(args,ask,inspect_only=True)
 if tool in ('double_click','right_click'):
  return ask('click',{**args,'button':'right' if tool=='right_click' else 'left','count':2 if tool=='double_click' else 1})
 if tool=='paste_text':return paste_text(args,ask)
 if clipboard_foreground_text(tool,args):return native_unicode_text(args,ask)
 if (tool in ('press_key','hotkey') and ('x' in args or 'y' in args) and
     (desktop_target_requested(args))):
  return desktop_keyboard_focus(tool,args,ask)
 if tool=='type_text' and isinstance(args.get('text'),str) and any(ord(ch)>127 for ch in args['text']):
  return native_unicode_refusal('unicode_background_unavailable',
    'Background key synthesis cannot preserve this text. No input was sent. Use foreground type_text with the primary desktop or an exact native window for UTF-8 paste.')
 return ask(tool,args)

def caption_capture(tool,args,result):
 # Put the coordinate contract beside every native image, not only in the
 # tool schema. Window captures are scaled; desktop captures have another
 # origin. This avoids applying desktop pixels to a scaled window action.
 if tool not in ('get_window_state','get_desktop_state') or result.get('isError'):return result
 state=result.get('structuredContent') or {}
 if not any(i.get('type')=='image' for i in result.get('content',[])):return result
 width=state.get('screenshot_width');height=state.get('screenshot_height')
 if not all(type(v) is int and v>0 for v in (width,height)):return result
 if tool=='get_window_state':
  pid=state.get('pid');wid=state.get('window_id')
  if not all(type(v) is int and v>0 for v in (pid,wid)):return result
  target={'scope':'window','pid':pid,'window_id':wid}
 else:
  if state.get('display')!='primary':return result
  target={'scope':'desktop'}
 instruction=('This native screenshot is %d by %d pixels. For coordinates read from THIS image, use these exact native input targeting fields: %s. '
              'For pointer/field targeting add x/y from this image. Use delivery_mode="foreground" where the schema supports it; keys/hotkeys take key/keys without x/y. '
              'Do not mix this with a target object or targeting fields from another capture. '
              'Desktop screenshot pixels must not be sent with pid/window_id; window screenshot pixels must not be sent with scope="desktop". '
              'For real hover, use get_desktop_state then move_cursor with scope="desktop", x/y, and no delivery_mode.')%(width,height,json.dumps(target,separators=(',',':')))
 return {**result,'content':result.get('content',[])+[{'type':'text','text':instruction}],
         'structuredContent':{**state,'native_input_target':target}}

class BrowserInputRecovery:
 """Prepare native targeting after a proven no-input browser refusal.

 Provider browser refs have no native coordinates, and some Chromium builds
 expose only a frame through AT-SPI. Never guess a ref-to-pixel conversion or
 replay an uncertain click. Supply an exact-window screenshot for the model's
 next native action instead. All calls remain inside the host computer lock.
 """
 def __init__(self):self.bindings={}
 def clear(self):self.bindings.clear()
 def complete(self,tool,args,result,ask):
  state=result.get('structuredContent') or {}
  if tool=='get_browser_state' and not result.get('isError') and state.get('mode')=='bind' and state.get('binding_quality')=='exact' and state.get('mutation_allowed') is True:
   pid=args.get('pid');wid=args.get('window_id');target=state.get('target_id')
   if type(pid) is int and type(wid) is int and pid>0 and wid>0 and isinstance(target,str):
    if len(self.bindings)>=32:self.bindings.pop(next(iter(self.bindings)))
    self.bindings[target]={'pid':pid,'window_id':wid}
  if tool not in ('browser_click','browser_pointer'):return result
  # Match the provider's explicit route refusal, not page text, permission
  # refusals, stale references, timeouts, or merely unverified delivery.
  text='\n'.join(i.get('text','') for i in result.get('content',[]) if i.get('type')=='text')
  refused=(state.get('effect')=='refused' and state.get('route')=='trusted_input' and
           (state.get('escalation') or {}).get('reason')=='route_unavailable' and
           text.startswith('refused (browser_input_trust_unavailable):'))
  code=(state.get('refusal') or {}).get('code') or state.get('code')
  action_unavailable=((state.get('effect')=='refused' or state.get('status')=='refused') and
                      (code=='browser_action_unavailable' or text.startswith('refused (browser_action_unavailable):')))
  if not refused and not action_unavailable:return result
  reason='browser_action_unavailable' if action_unavailable else 'browser_input_trust_unavailable'
  native=self.bindings.get(args.get('target_id'))
  if not native:return result
  recovery={'status':'inspect_required','reason':reason,
            'target':{'kind':'window',**native},'delivery_mode':'foreground',
            'action_performed':False,'automatic_retry':False}
  instruction=('The browser action was refused before input was sent. Native input is available on your assigned remote desktop. '
               'Inspect the fresh native window below and confirm the intended page/tab is visible. '
               'Use click, scroll, drag, press_key or hotkey with delivery_mode="foreground". '
               'For hover, capture get_desktop_state and use move_cursor with scope="desktop" and that desktop screenshot pixel space; window cursor movement is only a visual marker. '
               'Use a current native element_token when it represents the control; otherwise use coordinates from this exact window screenshot, '
               'even when an unusable browser ref exists. Do not convert browser refs or viewport coordinates into guessed desktop pixels. '
               'For a dropdown, open it, inspect its options, select the intended option, and verify the selected value. '
               'Do not repeat the refused browser action with dom_event for a control that requires real pointer/keyboard input. '
               'This recovery has not clicked anything.')
  content=[{'type':'text','text':instruction}]
  try:
   windows=ask('list_windows',{'pid':native['pid'],'on_screen_only':True})
   observed=(windows.get('structuredContent') or {}).get('windows',[])
   matches=[w for w in observed if w.get('pid')==native['pid'] and w.get('window_id')==native['window_id'] and w.get('is_on_screen') is True]
   if windows.get('isError') or len(matches)!=1:raise ValueError('Native window identity unavailable')
   capture={**native,'include_screenshot':True,'max_elements':250,'max_depth':12}
   if args.get('session'):capture['session']=args['session']
   snap=caption_capture('get_window_state',capture,ask('get_window_state',capture))
   ns=snap.get('structuredContent') or {}
   if snap.get('isError') or ns.get('pid')!=native['pid'] or ns.get('window_id')!=native['window_id']:
    raise ValueError('Native snapshot identity unavailable')
   if not any(i.get('type')=='image' for i in snap.get('content',[])):
    raise ValueError('Native screenshot unavailable')
   recovery['status']='native_target_ready'
   recovery['native_state']=ns
   content+=snap.get('content',[])
  except Exception:
   # The original action definitely did not run. A failed read must never
   # turn it into a repeated click or leak private provider error details.
   content=[{'type':'text','text':'Browser input was refused before any action. The native target could not be freshly verified. Use list_windows and get_window_state to inspect the intended window, then use native foreground controls. Do not guess coordinates or repeat an uncertain action.'}]
  return {**result,'isError':True,'content':content,
          'structuredContent':{**state,'recovery':recovery}}

def pointer_position():
 # Read the real remote X pointer. Input still goes exclusively through the
 # provider, with its session/permission checks, never through xdotool.
 result=subprocess.run(['xdotool','getmouselocation','--shell'],env=clipboard_environment(),
                       capture_output=True,text=True,timeout=1)
 if result.returncode:raise ValueError('Pointer position unavailable')
 fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
 return float(fields['X']),float(fields['Y'])

class SmoothPointer:
 """Animate coordinate input inside the existing single guest action/lock.

 No model instructions or alternate injection route. Coordinate movement
 requires a validated shared-model path; failures never send a click.
 """
 def __init__(self,position=pointer_position,clock=time.monotonic,sleep=time.sleep):
  self.position=position;self.clock=clock;self.sleep=sleep;self.clear()
 def clear(self):
  self.desktop=None;self.windows={};self.trajectory=None
 @staticmethod
 def good(result):
  state=result.get('structuredContent') or {}
  return not (result.get('isError') or state.get('status') in ('refused','error','failed') or
              state.get('effect') in ('refused','error','failed') or state.get('refusal'))
 @staticmethod
 def number(value):return type(value) in (int,float) and math.isfinite(value)
 @classmethod
 def dimensions(cls,state):
  return all(cls.number(state.get(k)) and state[k]>0 for k in ('screenshot_width','screenshot_height'))
 @classmethod
 def frame(cls,value):
  if not isinstance(value,dict):return None
  f={'x':value.get('x'),'y':value.get('y'),'w':value.get('w',value.get('width')),'h':value.get('h',value.get('height'))}
  return f if all(cls.number(v) for v in f.values()) and f['w']>0 and f['h']>0 else None
 @classmethod
 def window_frame(cls,window):
  return cls.frame(window.get('bounds')) or cls.frame(window.get('frame')) or cls.frame(window)
 @classmethod
 def obscured(cls,windows,matched,end):
  z=matched.get('z_index')
  if type(z) is not int:return True
  for w in windows:
   if (w.get('pid'),w.get('window_id'))==(matched.get('pid'),matched.get('window_id')):continue
   other_z=w.get('z_index')
   if type(other_z) is int and other_z<=z:continue
   covering=cls.window_frame(w)
   if covering is None or (covering['x']<=end[0]<covering['x']+covering['w'] and covering['y']<=end[1]<covering['y']+covering['h']):return True
  return False
 def observe(self,tool,args,result,raw=None):
  if tool not in ('get_desktop_state','get_window_state'):return
  state=result.get('structuredContent') or {}
  key=(args.get('pid'),args.get('window_id'))
  if tool=='get_window_state':self.windows.pop(key,None)
  else:self.desktop=None
  if not self.good(result) or not self.dimensions(state):return
  if not any(item.get('type')=='image' for item in result.get('content',[])):return
  if tool=='get_desktop_state':
   if state.get('display')!='primary' or not all(self.number(state.get(k)) and state[k]>0 for k in ('screen_width','screen_height')):return
   self.desktop={k:state[k] for k in ('screen_width','screen_height','screenshot_width','screenshot_height')}
  else:
   if key!=(state.get('pid'),state.get('window_id')):return
   frames=[self.frame(e.get('frame')) for e in state.get('elements',[]) if e.get('depth')==0 and e.get('role') in ('frame','window')]
   f=frames[0] if len(frames)==1 else None
   # Chromium can return a valid native screenshot with no accessibility
   # root bounds. Read that exact window's native geometry alongside it;
   # never infer offsets from browser content or a guessed title-bar size.
   if f is None and raw:
    try:
     listed=raw('list_windows',{'pid':key[0],'on_screen_only':True})
     matching=[w for w in (listed.get('structuredContent') or {}).get('windows',[]) if (w.get('pid'),w.get('window_id'))==key and w.get('is_on_screen') is True]
     if self.good(listed) and len(matching)==1:f=self.window_frame(matching[0])
    except Exception:pass # Geometry enhancement must not fail a valid capture.
   if f is None:return
   self.windows[key]={'frame':f,**{k:state[k] for k in ('screenshot_width','screenshot_height')}}
   if len(self.windows)>16:self.windows.pop(next(iter(self.windows)))
 @staticmethod
 def annotated(result,state):
  return {**result,'structuredContent':{**(result.get('structuredContent') or {}),'cursor_motion':state}}
 def prepare(self,tool,args,raw):
  if tool in ('double_click','right_click'):tool='click'
  def send(name,values):
   result=raw(name,values);self.observe(name,values,result,raw);return result
  if tool not in ('click','move_cursor','type_text','press_key','hotkey','scroll'):return None,None
  target=args.get('target') or {}
  if not isinstance(target,dict):return None,None
  if target.get('kind')=='desktop' and args.get('scope') not in (None,'desktop'):return None,None
  desktop=args.get('scope')=='desktop' or target.get('kind')=='desktop'
  if (tool!='move_cursor' and args.get('delivery_mode')!='foreground') or (tool=='move_cursor' and not desktop):return None,None
  if (any(k in args for k in ('element_token','element_index','snapshot_id')) or args.get('from_zoom') or
      not all(self.number(args.get(k)) for k in ('x','y'))):return None,None
  def skipped(reason):return None,reason
  session={k:args[k] for k in ('session',) if k in args}
  window=None;original_frame=None
  if desktop:
   if any(k in args for k in ('pid','window_id')) or target.get('kind') not in (None,'desktop') or target.get('display_id','primary')!='primary':return None,None
   capture=self.desktop
   if not capture:return skipped('desktop_capture_required')
   if not (0<=args['x']<capture['screenshot_width'] and 0<=args['y']<capture['screenshot_height']):return None,None
   end=(args['x']*capture['screen_width']/capture['screenshot_width'],args['y']*capture['screen_height']/capture['screenshot_height'])
  else:
   if target.get('kind') not in (None,'window'):return None,None
   pid=args.get('pid',target.get('pid'));wid=args.get('window_id',target.get('window_id'))
   if any(k in args and k in target and args[k]!=target[k] for k in ('pid','window_id')):return None,None
   window=(pid,wid);capture=self.windows.get(window)
   if not capture:return skipped('window_capture_required')
   if not (0<=args['x']<capture['screenshot_width'] and 0<=args['y']<capture['screenshot_height']):return None,None
   check=send('list_windows',{'on_screen_only':True})
   if not self.good(check):return skipped('window_geometry_unavailable')
   windows=(check.get('structuredContent') or {}).get('windows',[])
   matched=[w for w in windows if (w.get('pid'),w.get('window_id'))==window and w.get('is_on_screen') is True]
   original_frame=capture['frame']
   if len(matched)!=1 or self.window_frame(matched[0])!=original_frame:return skipped('window_geometry_changed')
   # Do not hover an obscuring window while aiming at one behind it. The
   # caller must bring the intended window forward and observe it again.
   f=original_frame
   end=(f['x']+args['x']*f['w']/capture['screenshot_width'],f['y']+args['y']*f['h']/capture['screenshot_height'])
   z=matched[0].get('z_index')
   if type(z) is not int:return skipped('window_stacking_unavailable')
   if self.obscured(windows,matched[0],end):return skipped('window_obscured')
  # Window and desktop captures have separate provider mappings. A desktop
  # observation is needed to translate physical coordinates for move_cursor;
  # it never reindexes native window element handles.
  if not self.desktop:
   read=send('get_desktop_state',session)
   if not self.good(read) or not self.desktop:return skipped('desktop_capture_unavailable')
  d=self.desktop
  if not (0<=end[0]<d['screen_width'] and 0<=end[1]<d['screen_height']):return skipped('target_outside_desktop')
  try:start=self.position()
  except (OSError,ValueError,KeyError,subprocess.TimeoutExpired):return skipped('pointer_position_unavailable')
  if len(start)!=2 or not all(self.number(v) for v in start):return skipped('pointer_position_unavailable')
  if not (0<=start[0]<d['screen_width'] and 0<=start[1]<d['screen_height']):return skipped('pointer_outside_desktop')
  return {'start':list(start),'end':list(end),'screen':[d['screen_width'],d['screen_height']],'window':list(window) if window else None,'frame':original_frame,'desktop':d},None
 def planned_path(self,context):
  candidate=self.trajectory
  def unavailable(reason):return None,{'reason':reason}
  if candidate is None:return unavailable('model_path_required')
  if not isinstance(candidate,dict) or candidate.get('generator')!='onnx':return unavailable('invalid_plan')
  for key in ('screen','window','frame'):
   if candidate.get(key)!=context[key]:return unavailable('target_changed')
  for key in ('start','end'):
   value=candidate.get(key)
   if not isinstance(value,list) or len(value)!=2 or not all(self.number(v) for v in value):return unavailable('invalid_plan')
   if any(abs(a-b)>.5 for a,b in zip(value,context[key])):return unavailable('position_changed')
  points=candidate.get('points')
  width,height=context['screen']
  if (not isinstance(points,list) or not 2<=len(points)<=32 or
      any(not isinstance(p,list) or len(p)!=2 or not all(self.number(v) for v in p) or not (0<=p[0]<width and 0<=p[1]<height) for p in points)):
   return unavailable('invalid_plan')
  if points[0]!=candidate['start'] or points[-1]!=candidate['end']:return unavailable('invalid_endpoint')
  # Reject corrupt or wildly circuitous output before any input.
  distance=math.dist(context['start'],context['end'])
  if sum(math.dist(a,b) for a,b in zip(points,points[1:]))>max(16,distance*3):return unavailable('excessive_path')
  duration=min(.42,.14+distance/2400)
  path=[(duration*i/(len(points)-1),tuple(point)) for i,point in enumerate(points) if i]
  path[-1]=(duration,tuple(context['end']))
  info={'generator':'onnx'}
  if self.number(candidate.get('generation_ms')):info['generation_ms']=round(candidate['generation_ms'],2)
  return path,info
 def call(self,tool,args,raw):
  def send(name,values):
   result=raw(name,values);self.observe(name,values,result,raw);return result
  context,reason=self.prepare(tool,args,raw)
  if context is None:
   if reason:return self.annotated(native_unicode_refusal('cursor_model_context_unavailable','Model cursor movement could not be prepared. No input was sent; inspect the screen before trying again.'),{'status':'refused','reason':reason,'click_sent':False})
   return send(tool,args)
  start=context['start'];end=context['end'];d=context['desktop'];window=tuple(context['window']) if context['window'] else None;original_frame=context['frame']
  session={k:args[k] for k in ('session',) if k in args}
  path,generation=self.planned_path(context)
  if path is None:return self.annotated(native_unicode_refusal('cursor_model_path_unavailable','A valid model-generated cursor path is required. No input was sent; inspect the screen before trying again.'),{'status':'refused',**generation,'click_sent':False})
  began=self.clock();moves=0
  def timed_out():
   return self.annotated(native_unicode_refusal('cursor_motion_timeout','Cursor movement did not finish in time. No click was sent; inspect the current screen.'),{'status':'interrupted','moves':moves,'click_sent':False})
  for offset,point in path:
   if self.clock()-began>1.5:return timed_out()
   self.sleep(max(0,began+offset-self.clock()))
   if self.clock()-began>1.5:return timed_out()
   # Clamp the small arc at display edges, never the exact target.
   x=min(d['screen_width']-1,max(0,point[0]))*d['screenshot_width']/d['screen_width']
   y=min(d['screen_height']-1,max(0,point[1]))*d['screenshot_height']/d['screen_height']
   moved=send('move_cursor',{**session,**({ 'cursor_id':args['cursor_id']} if 'cursor_id' in args else {}),'scope':'desktop','x':x,'y':y})
   moves+=1
   if not self.good(moved):
    return self.annotated({**moved,'content':moved.get('content',[])+[{'type':'text','text':'Cursor movement stopped. No click was sent; inspect the current screen.'}]},{'status':'interrupted','moves':moves,'click_sent':False})
  if self.clock()-began>1.5:return timed_out()
  if window and path:
   check=send('list_windows',{'on_screen_only':True})
   windows=(check.get('structuredContent') or {}).get('windows',[])
   matches=[w for w in windows if (w.get('pid'),w.get('window_id'))==window and w.get('is_on_screen') is True]
   if not self.good(check) or len(matches)!=1 or self.window_frame(matches[0])!=original_frame or self.obscured(windows,matches[0],end):
    return self.annotated(native_unicode_refusal('cursor_target_changed','The target window moved or became obscured during cursor movement. No click was sent; inspect the current screen.'),{'status':'interrupted','moves':moves,'click_sent':False})
  # Exactly one final click, with its original target/button/count/modifiers.
  # A requested move has already landed and must not dispatch a second move.
  if self.clock()-began>1.5:return timed_out()
  result=moved if tool=='move_cursor' and path else send(tool,args)
  return self.annotated(result,{'status':'completed','moves':moves,'duration_ms':round((self.clock()-began)*1000),**generation})

def serve():
 base.mkdir(parents=True,exist_ok=True)
 # Only bootstrap starts this process, after checking the existing socket.
 try:os.unlink(sockpath)
 except FileNotFoundError:pass
 listener=socket.socket(socket.AF_UNIX);listener.bind(sockpath);os.chmod(sockpath,0o600);listener.listen(4)
 def deadline(signum,frame):raise TimeoutError('Desktop action deadline')
 signal.signal(signal.SIGALRM,deadline)
 driver=None;counter=0;session='td-'+uuid.uuid4().hex[:16];recovery=BrowserInputRecovery();motion=SmoothPointer()
 def request(method,params):
  nonlocal counter
  counter+=1
  driver.stdin.write(json.dumps({'jsonrpc':'2.0','id':counter,'method':method,'params':params})+'\n');driver.stdin.flush()
  while True:
   line=driver.stdout.readline()
   if not line:raise RuntimeError('Desktop driver closed; inspect fresh state before another action')
   r=json.loads(line)
   if r.get('id')==counter:return r
 def open_session():
  nonlocal session
  recovery.clear();motion.clear()
  session='td-'+uuid.uuid4().hex[:16]
  r=request('tools/call',{'name':'start_session','arguments':{'session':session}})
  if 'error' in r or r.get('result',{}).get('isError'):raise RuntimeError('Desktop session could not start')
 def start():
  nonlocal driver
  provider_ready()
  driver=subprocess.Popen([cua,'mcp','--socket',provider],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
  request('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'tameduck','version':'1.0'}})
  driver.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');driver.stdin.flush()
  open_session()
 def raw_ask(tool,args):
  def send(name,values):
   response=request('tools/call',{'name':name,'arguments':values})
   if 'error' in response:raise RuntimeError(response['error'].get('message','Desktop driver error'))
   return response.get('result',{})
  return foreground_retry(send,tool,args)
 def ask(tool,args):return motion.call(tool,args,raw_ask)
 def expired(result):
  # The desktop ends a session on its own schedule, and from then on it accepts
  # every action and performs none, saying so only inside the answer. This
  # process stays alive and healthy the whole time, so nothing noticed: every
  # screenshot, click and paste on that machine was refused until somebody
  # restarted it, and nobody knew to. The answer says the call 'was rejected',
  # so nothing happened and asking again on a fresh session repeats no action.
  if not result.get('isError'):return False
  said=' '.join(i.get('text','') for i in result.get('content',[]) if i.get('type')=='text')
  return 'has ended' in said and 'start_session' in said
 while True:
  connection,_=listener.accept()
  with connection:
   try:
    connection.settimeout(30)
    stream=connection.makefile('rb');line=stream.readline(65537)
    if len(line)>65536:raise RuntimeError('Desktop request too large')
    payload=json.loads(line)
    if payload.get('ping'):
     connection.sendall(b'{"ready":true}\n');continue
    # Write down which pages are open, on request. The same thing happens after
    # every one of the duck's own actions below - but a person who takes the
    # screen over drives the desktop directly, so none of those run, and the
    # list stayed as the duck had left it. Their machine then came back showing
    # a page from hours earlier. Answered here, above the driver, so a wedged
    # desktop cannot stop the list being saved.
    if payload.get('save'):
     save_browser();connection.sendall(b'{"saved":true}\n');continue
    signal.alarm(24)
    if driver is None or driver.poll() is not None:start()
    if payload.get('checkpoint'):
     with open(base/'progress.json','w') as f:json.dump({'checkpoint':payload['checkpoint']},f)
    if payload.get('tool')=='__cursor_probe':
     signal.alarm(3)
     probe=payload.get('arguments') or {}
     values=dict(probe.get('arguments') or {})
     if 'session' in values:values['session']=session
     context,reason=motion.prepare(probe.get('tool'),values,raw_ask)
     pointer={k:context[k] for k in ('start','end','screen','window','frame')} if context else None
     signal.alarm(0)
     connection.sendall(json.dumps({'pointer':pointer,'reason':reason},separators=(',',':')).encode()+b'\n')
     continue
    args=payload.get('arguments',{})
    if 'session' in args:args['session']=session
    def reconnect_implicit_read():
     nonlocal driver
     driver.kill();driver.wait();driver=None
     start()
    def action():
     page_ask=(composed_page_ask(ask,expired,reconnect_implicit_read,lambda:session)
               if payload['tool'] in ('open_page','read_page_address') else ask)
     return dispatch_action(payload['tool'],args,page_ask)
    motion.trajectory=payload.get('cursor_trajectory')
    try:result=action()
    finally:motion.trajectory=None
    # A composed focus + paste has no safe whole-action retry after any
    # partial response; leave an expired-session refusal for fresh inspection.
    if expired(result) and payload['tool'] not in ('open_page','read_page_address') and not (clipboard_foreground_text(payload['tool'],args) or desktop_keyboard_focus_requested(payload['tool'],args)):
     if 'session' in args:
      open_session()
      args['session']=session
     else:
      # list_windows cannot carry an explicit session. A new explicit id
      # cannot revive its expired implicit transport. The call was rejected,
      # so replacing the transport and retrying once repeats no action.
      driver.kill();driver.wait();driver=None
      start()
     result=action()
    result=recovery.complete(payload['tool'],args,result,ask)
    result=caption_capture(payload['tool'],args,result)
    for item in result.get('content',[]):
     if item.get('type')=='image':
      from PIL import Image
      im=Image.open(io.BytesIO(base64.b64decode(item['data']))).convert('RGB')
      buf=io.BytesIO();im.save(buf,format='JPEG',quality=62,optimize=True)
      item['data']=base64.b64encode(buf.getvalue()).decode();item['mimeType']='image/jpeg'
    signal.alarm(0)
    save_browser()
    connection.sendall(json.dumps(result,separators=(',',':')).encode()+b'\n')
   except Exception as error:
    print(type(error).__name__, [(f.name,f.lineno) for f in traceback.extract_tb(error.__traceback__)],file=sys.stderr,flush=True)
    signal.alarm(0)
    # Never repeat an action whose outcome may be unknown. A new call can reconnect.
    if driver is not None:
     driver.kill();driver.wait();driver=None
    try:connection.sendall(b'{"isError":true,"content":[{"type":"text","text":"Desktop connection was interrupted. Inspect fresh state before any further action."}]}\n')
    except OSError:pass

# Run with --serve it serves; run with a payload it forwards one; imported with
# neither it does nothing at all, so the pieces above can be tested directly
# instead of only through a spawned desktop.
if len(sys.argv)>1 and sys.argv[1]=='--serve':
 serve()
elif len(sys.argv)>1:
 payload=json.loads(base64.b64decode(sys.argv[1]))
 # Only the connect is retried, and only before anything is sent, so no action can
 # repeat. Desktop controls restart in about a second; without this a restart in
 # flight surfaced as a failed computer action rather than a short wait.
 deadline=time.monotonic()+5;restarted=False
 while True:
  client=socket.socket(socket.AF_UNIX);client.settimeout(28)
  try:
   client.connect(sockpath);break
  except (ConnectionRefusedError,FileNotFoundError):
   client.close()
   if time.monotonic()>=deadline:
    # Five seconds with nobody there is not a restart in flight. A resumed
    # machine had its controls running, their socket on disk, and every
    # connection refused until somebody restarted them by hand. Controls that
    # are not running at all are something else: the machine has lost its
    # setup - rebooted, say - and this refusal is what tells the host to redo
    # all of it, the browser included. Restarting only the controls here hid
    # that and left the rest undone.
    if restarted or systemctl('is-active','tameduck-control.service')!='active':raise
    restart('tameduck-control.service');restarted=True
    deadline=time.monotonic()+10
   time.sleep(.25)
 client.sendall(json.dumps(payload).encode()+b'\n')
 with client.makefile('rb') as f:
  line=f.readline(8*1024*1024)
  if not line:raise RuntimeError('Desktop connection closed')
  sys.stdout.write(line.decode())
 client.close()
